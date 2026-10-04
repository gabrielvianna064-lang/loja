// ============================================================
// LOJA DE APLICATIVOS — SERVIDOR AVANÇADO
// Node.js + Express + Mercado Pago OAuth PKCE + Firebase REST
// Pagamentos + Webhook + Licenças por compra
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const nodemailer = require("nodemailer");

const app = express();

// ============================================================
// CENTRAL DO VENDEDOR — ATUALIZAÇÃO EM TEMPO REAL (SSE)
// ============================================================
const clientesCentralTempoReal = new Map();

function enviarEventoCentral(vendedorId, tipo = "atualizacao", dados = {}) {
    const id = String(vendedorId || "").trim();
    if (!id) return;
    const clientes = clientesCentralTempoReal.get(id);
    if (!clientes || !clientes.size) return;

    const payload = JSON.stringify({
        tipo,
        vendedorId: id,
        agora: Date.now(),
        ...dados
    });

    for (const res of [...clientes]) {
        try {
            res.write(`event: ${tipo}\ndata: ${payload}\n\n`);
        } catch {
            clientes.delete(res);
        }
    }

    if (!clientes.size) clientesCentralTempoReal.delete(id);
}

function enviarAtualizacaoCentral(vendedorId, motivo = "atualizacao") {
    enviarEventoCentral(vendedorId, "atualizacao", { motivo });
}


// ============================================================
// CONFIGURAÇÃO
// ============================================================

const PORTA = Number(process.env.PORTA || 3000);
const BASE_URL = String(process.env.BASE_URL || "").trim().replace(/\/$/, "");

const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();
const MP_CLIENT_ID = String(process.env.MP_CLIENT_ID || "").trim();
const MP_CLIENT_SECRET = String(process.env.MP_CLIENT_SECRET || "").trim();
const MP_PUBLIC_KEY = String(process.env.MP_PUBLIC_KEY || "").trim();
const MP_TEST_MODE = String(process.env.MP_MODO || "producao").toLowerCase() === "teste";
const MP_TEST_ACCESS_TOKEN = String(process.env.MP_TEST_ACCESS_TOKEN || "").trim();
const MP_TEST_PUBLIC_KEY = String(process.env.MP_TEST_PUBLIC_KEY || "").trim();
const MP_PAYMENT_ACCESS_TOKEN = MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : MP_ACCESS_TOKEN;
const MP_PAYMENT_PUBLIC_KEY = MP_TEST_MODE ? MP_TEST_PUBLIC_KEY : MP_PUBLIC_KEY;
const MP_REDIRECT_URI = String(
    process.env.MP_REDIRECT_URI ||
    "https://loja-bvjb.onrender.com/mercadopago/callback"
).trim();

const FIREBASE_DATABASE_URL = String(
    process.env.FIREBASE_DATABASE_URL || ""
).trim().replace(/\/+$/, "");

const LICENCA_SALT = String(
    process.env.LICENCA_SALT || "troque-este-segredo-no-env"
).trim();

const LICENCA_PREFIXO = String(
    process.env.LICENCA_PREFIXO || "APP"
).trim().toUpperCase();

// ============================================================
// E-MAIL SMTP
// ============================================================
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || "").trim();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "gabrielvianna064@gmail.com").trim().toLowerCase();
const REEMBOLSO_JANELA_MINUTOS = 2;
const REEMBOLSO_JANELA_MS = REEMBOLSO_JANELA_MINUTOS * 60 * 1000;
const FIREBASE_WEB_API_KEY = String(process.env.FIREBASE_WEB_API_KEY || "AIzaSyAMG8workhkRJapQm1AHSMOSIPOnSWltpw").trim();
const PUBLIC_URL = String(
    process.env.BASE_URL ||
    (() => { try { return new URL(MP_REDIRECT_URI).origin; } catch { return `http://localhost:${PORTA}`; } })()
).trim().replace(/\/$/, "");

const smtpConfigurado = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const emailTransporter = smtpConfigurado
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
    : null;

if (!MP_TEST_MODE && !MP_CLIENT_ID) {
    console.error("ERRO: MP_CLIENT_ID não configurado.");
    process.exit(1);
}

if (!MP_TEST_MODE && !MP_CLIENT_SECRET) {
    console.error("ERRO: MP_CLIENT_SECRET não configurado.");
    process.exit(1);
}

if (!FIREBASE_DATABASE_URL) {
    console.error("ERRO: FIREBASE_DATABASE_URL não configurado.");
    process.exit(1);
}

if (MP_TEST_MODE) {
    if (!MP_TEST_ACCESS_TOKEN) console.warn("AVISO: MP_TEST_ACCESS_TOKEN não configurado.");
    if (!MP_TEST_PUBLIC_KEY) console.warn("AVISO: MP_TEST_PUBLIC_KEY não configurada. Pagamentos com cartão não poderão inicializar.");
} else {
    if (!MP_ACCESS_TOKEN) console.warn("AVISO: MP_ACCESS_TOKEN não configurado. Pagamentos dependerão do token OAuth do vendedor.");
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Nunca exponha APKs diretamente pelo middleware de arquivos estáticos.
app.use((req, res, next) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { return res.status(400).end(); }
    if (/\\.apk$/i.test(pathname)) {
        return res.status(403).json({ erro: "APK disponível somente após pagamento aprovado." });
    }
    next();
});
app.use(express.static(__dirname, {
    index: false,
    setHeaders(res, filePath) {
        if (/\\.apk$/i.test(filePath)) res.setHeader("Cache-Control", "no-store");
    }
}));

// ============================================================
// UPLOAD DE MÍDIA DOS PRODUTOS — ARMAZENAMENTO NO DISCO DO SERVIDOR
// Sem Firebase Storage: os arquivos ficam no disco do servidor, separados por vendedor.
// O Firebase RTDB recebe somente URL + metadados.
// ============================================================

const PASTA_UPLOADS = path.join(__dirname, "uploads");
const PASTA_TMP_UPLOADS = path.join(PASTA_UPLOADS, "_tmp");

fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
fs.mkdirSync(PASTA_TMP_UPLOADS, { recursive: true });

app.use("/uploads", (req, res, next) => {
    if (req.path.toLowerCase().endsWith(".apk")) return res.status(403).json({ erro: "Use o download autorizado após o pagamento." });
    next();
});

app.use("/uploads", express.static(PASTA_UPLOADS, {
    fallthrough: false,
    maxAge: "1h"
}));

// Limite total de armazenamento por vendedor: 2.500 GB (2,5 TB).
// O valor é usado tanto na consulta do painel quanto no bloqueio de uploads.
const LIMITE_ARMAZENAMENTO_VENDEDOR_2500GB = 2500 * 1024 * 1024 * 1024;
// Limite máximo de um único arquivo: 2.500 GB.
const LIMITE_ARQUIVO_2500GB = LIMITE_ARMAZENAMENTO_VENDEDOR_2500GB;

const storageUpload = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, PASTA_TMP_UPLOADS);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase();
        const base = path.basename(file.originalname || "arquivo", ext)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "arquivo";

        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${base}${ext}`);
    }
});

const uploadProduto2500GB = multer({
    storage: storageUpload,
    limits: { fileSize: LIMITE_ARQUIVO_2500GB },
    fileFilter: (_req, file, cb) => {
        const nome = String(file.originalname || "").toLowerCase();
        const mime = String(file.mimetype || "").toLowerCase();

        const permitido =
            mime.startsWith("image/") ||
            mime.startsWith("video/") ||
            mime === "application/vnd.android.package-archive" ||
            nome.endsWith(".apk");

        if (!permitido) {
            return cb(new Error("TIPO_DE_ARQUIVO_NAO_PERMITIDO"));
        }

        cb(null, true);
    }
});

function textoSeguroUpload(valor, padrao = "") {
    return String(valor ?? padrao)
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .slice(0, 120);
}

function pastaUploadPorTipo(pasta, arquivo) {
    const p = String(pasta || "").toLowerCase();

    if (p.includes("imagem") || p === "images" || p === "image") return "imagens";
    if (p.includes("video") || p === "videos" || p === "video") return "videos";
    if (p.includes("apk") || p.includes("arquivo") || p === "downloads") return "apk";

    const mime = String(arquivo?.mimetype || "").toLowerCase();
    if (mime.startsWith("image/")) return "imagens";
    if (mime.startsWith("video/")) return "videos";
    return "apk";
}


// ============================================================
// ARMAZENAMENTO DO VENDEDOR — DISCO DO SERVIDOR
// Cada vendedor possui uma pasta própria em:
// uploads/<vendedorId>/<produtoId>/...
// O painel consulta o tamanho real desses arquivos.
// ============================================================

function calcularTamanhoDiretorio(diretorio) {
    if (!diretorio || !fs.existsSync(diretorio)) return 0;

    let total = 0;

    for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
        const caminho = path.join(diretorio, entrada.name);

        // Arquivos temporários não entram no espaço utilizado.
        if (entrada.name === "_tmp") continue;

        try {
            if (entrada.isDirectory()) {
                total += calcularTamanhoDiretorio(caminho);
            } else if (entrada.isFile()) {
                total += fs.statSync(caminho).size;
            }
        } catch (erro) {
            console.warn("Não foi possível ler o tamanho de:", caminho, erro.message);
        }
    }

    return total;
}

function formatarGB(bytes) {
    return Number((bytes / (1024 * 1024 * 1024)).toFixed(2));
}

function obterCaminhoVendedor(vendedorId) {
    const id = textoSeguroUpload(vendedorId, "sem-vendedor");
    return path.join(PASTA_UPLOADS, id);
}

// GET usado pela Central do Vendedor.
app.get("/api/armazenamento/:vendedorId", (req, res) => {
    try {
        const vendedorId = textoSeguroUpload(req.params.vendedorId, "");

        if (!vendedorId) {
            return res.status(400).json({
                sucesso: false,
                erro: "VENDEDOR_NAO_INFORMADO",
                mensagem: "Vendedor não informado."
            });
        }

        const pastaVendedor = obterCaminhoVendedor(vendedorId);
        const usadoBytes = calcularTamanhoDiretorio(pastaVendedor);
        const limiteBytes = LIMITE_ARMAZENAMENTO_VENDEDOR_2500GB;
        const disponivelBytes = Math.max(0, limiteBytes - usadoBytes);
        const percentual = Math.min(
            100,
            Number(((usadoBytes / limiteBytes) * 100).toFixed(4))
        );

        return res.json({
            sucesso: true,
            vendedorId,
            limiteBytes,
            usadoBytes,
            disponivelBytes,
            limiteGB: 2500,
            usadoGB: formatarGB(usadoBytes),
            disponivelGB: formatarGB(disponivelBytes),
            percentual,
            pasta: `uploads/${vendedorId}`,
            servidor: true,
            atualizadoEm: Date.now()
        });
    } catch (erro) {
        console.error("Erro consultando armazenamento:", erro);
        return res.status(500).json({
            sucesso: false,
            erro: "ERRO_ARMAZENAMENTO",
            mensagem: "Não foi possível consultar o armazenamento do servidor."
        });
    }
});

app.post("/api/upload-arquivo", (req, res) => {
    uploadProduto2500GB.single("arquivo")(req, res, (erro) => {
        if (erro) {
            if (erro instanceof multer.MulterError && erro.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({
                    sucesso: false,
                    erro: "ARQUIVO_MAIOR_QUE_2500GB",
                    mensagem: "O arquivo ultrapassa o limite de 2.500 GB."
                });
            }

            if (erro.message === "TIPO_DE_ARQUIVO_NAO_PERMITIDO") {
                return res.status(400).json({
                    sucesso: false,
                    erro: "TIPO_DE_ARQUIVO_NAO_PERMITIDO",
                    mensagem: "Envie somente imagem, vídeo ou arquivo APK."
                });
            }

            console.error("Erro no upload:", erro);
            return res.status(500).json({
                sucesso: false,
                erro: "ERRO_UPLOAD",
                mensagem: erro.message || "Não foi possível enviar o arquivo."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                sucesso: false,
                erro: "ARQUIVO_NAO_ENVIADO",
                mensagem: "Nenhum arquivo foi enviado no campo 'arquivo'."
            });
        }

        // Verifica a cota TOTAL do vendedor antes de mover o arquivo
        // para a pasta definitiva. O arquivo temporário é removido se
        // a cota de 2.500 GB for ultrapassada.
        try {
            const vendedorIdBruto = textoSeguroUpload(
                req.body.vendedorId || req.body.vendedor || "sem-vendedor",
                "sem-vendedor"
            );
            const usadoAntesBytes = calcularTamanhoDiretorio(
                obterCaminhoVendedor(vendedorIdBruto)
            );

            if (usadoAntesBytes + Number(req.file.size || 0) > LIMITE_ARMAZENAMENTO_VENDEDOR_2500GB) {
                try {
                    if (req.file.path && fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                    }
                } catch {}

                return res.status(413).json({
                    sucesso: false,
                    erro: "QUOTA_2500GB_EXCEDIDA",
                    mensagem: "O armazenamento deste vendedor atingiu o limite de 2.500 GB.",
                    limiteGB: 2500,
                    usadoGB: formatarGB(usadoAntesBytes),
                    disponivelGB: formatarGB(Math.max(0, LIMITE_ARMAZENAMENTO_VENDEDOR_2500GB - usadoAntesBytes))
                });
            }
        } catch (erroQuota) {
            console.error("Erro verificando cota do vendedor:", erroQuota);
            try {
                if (req.file.path && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
            } catch {}

            return res.status(500).json({
                sucesso: false,
                erro: "ERRO_VERIFICANDO_COTA",
                mensagem: "Não foi possível verificar a cota de armazenamento do vendedor."
            });
        }

        try {
            const vendedorId = textoSeguroUpload(
                req.body.vendedorId || req.body.vendedor || "sem-vendedor",
                "sem-vendedor"
            );

            const produtoId = textoSeguroUpload(
                req.body.produtoId || req.body.id || `produto-${Date.now()}`,
                `produto-${Date.now()}`
            );

            const tipo = pastaUploadPorTipo(
                req.body.pasta || req.body.tipo,
                req.file
            );

            const pastaFinal = path.join(
                PASTA_UPLOADS,
                vendedorId,
                produtoId,
                tipo
            );

            fs.mkdirSync(pastaFinal, { recursive: true });

            const destinoFinal = path.join(
                pastaFinal,
                path.basename(req.file.filename)
            );

            fs.renameSync(req.file.path, destinoFinal);

            const url = `/uploads/${encodeURIComponent(vendedorId)}/${encodeURIComponent(produtoId)}/${tipo}/${encodeURIComponent(path.basename(req.file.filename))}`;

            return res.json({
                sucesso: true,
                ok: true,
                url,
                caminho: url,
                nome: req.file.originalname,
                nomeOriginal: req.file.originalname,
                arquivo: path.basename(req.file.filename),
                tamanho: req.file.size,
                tamanhoMB: Number((req.file.size / (1024 * 1024)).toFixed(2)),
                tipo,
                mimeType: req.file.mimetype,
                vendedorId,
                produtoId
            });
        } catch (erroFinal) {
            try {
                if (req.file?.path && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
            } catch {}

            console.error("Erro finalizando upload:", erroFinal);
            return res.status(500).json({
                sucesso: false,
                erro: "ERRO_AO_SALVAR_ARQUIVO",
                mensagem: "Não foi possível salvar o arquivo no servidor."
            });
        }
    });
});


// DOWNLOAD PROTEGIDO: identidade Firebase + pedido pago + licença ativa.
async function usuarioFirebaseDoToken(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const resposta = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token })
    });
    if (!resposta.ok) return null;
    return (await resposta.json()).users?.[0] || null;
}

async function autorizarDownload(req, res, enviarArquivo) {
    try {
        const usuario = await usuarioFirebaseDoToken(req);
        if (!usuario?.localId) return res.status(401).json({ liberado: false, erro: "Entre na sua conta." });
        const produtoId = String(req.params.produtoId || "");
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(produtoId)) return res.status(400).json({ liberado: false, erro: "Produto inválido." });
        const produto = await firebaseGet(`produtos/${produtoId}`);
        if (!produto) return res.status(404).json({ liberado: false, erro: "Produto não encontrado." });
        const pedidos = await firebaseGet("pedidos") || {};
        let pedidoValido = null;
        for (const pedido of Object.values(pedidos)) {
            if (String(pedido?.produtoId || "") !== produtoId || String(pedido?.compradorId || "") !== usuario.localId || pedido?.status !== "pago" || !pedido?.licencaId) continue;
            const licenca = await firebaseGet(`licencas/${encodeURIComponent(String(pedido.licencaId))}`);
            if (licenca?.status === "ativa" && String(licenca.produtoId) === produtoId && String(licenca.compradorId) === usuario.localId) { pedidoValido = pedido; break; }
        }
        if (!pedidoValido) return res.status(403).json({ liberado: false, erro: "Pagamento ainda não aprovado ou licença indisponível." });
        const bruto = produto.apkUrl || produto.apk?.url || produto.arquivoApk?.url || produto.downloadUrl;
        const url = typeof bruto === "string" ? bruto : bruto?.url;
        if (!url) return res.status(404).json({ liberado: false, erro: "APK não cadastrado." });
        let pathname;
        try { pathname = new URL(url, PUBLIC_URL).pathname; } catch { return res.status(400).json({ liberado: false, erro: "URL inválida." }); }
        if (!pathname.startsWith("/uploads/") || !pathname.toLowerCase().endsWith(".apk")) return res.status(409).json({ liberado: false, erro: "Configure o APK no armazenamento deste servidor." });
        const partes = pathname.slice(9).split("/").map(decodeURIComponent);
        if (partes.some(p => !p || p === "." || p === ".." || p.includes("/") || p.includes("\\"))) return res.status(400).json({ liberado: false, erro: "Caminho inválido." });
        const arquivo = path.resolve(PASTA_UPLOADS, ...partes);
        if (!arquivo.startsWith(path.resolve(PASTA_UPLOADS) + path.sep)) return res.status(403).end();
        if (!fs.existsSync(arquivo)) return res.status(404).json({ liberado: false, erro: "APK não encontrado no servidor." });
        if (!enviarArquivo) return res.json({ liberado: true });
        return res.download(arquivo, path.basename(arquivo));
    } catch (erro) { console.error("Download protegido:", erro); return res.status(500).json({ liberado: false, erro: "Falha ao verificar compra." }); }
}
app.get("/api/produtos/:produtoId/download/status", (req, res) => autorizarDownload(req, res, false));
app.get("/api/produtos/:produtoId/download", (req, res) => autorizarDownload(req, res, true));

// ============================================================
// SESSÕES OAUTH PKCE
// ============================================================

const oauthSessions = new Map();

function gerarState() {
    return crypto.randomBytes(32).toString("hex");
}

function gerarCodeVerifier() {
    return crypto.randomBytes(48).toString("base64url");
}

function gerarCodeChallenge(codeVerifier) {
    return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

function limparSessoesOAuth() {
    const agora = Date.now();
    const limite = 10 * 60 * 1000;

    for (const [state, sessao] of oauthSessions) {
        if (agora - sessao.criadoEm > limite) oauthSessions.delete(state);
    }
}

// ============================================================
// UTILITÁRIOS
// ============================================================

function texto(valor, fallback = "") {
    const v = String(valor ?? "").trim();
    return v || fallback;
}

function escapeHtml(valor) {
    return String(valor ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizarPreco(valor) {
    if (typeof valor === "string") valor = valor.replace(",", ".").trim();
    const n = Number(valor);
    return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}



// ============================================================
// MAKETIPLACE — TAXAS AUTOMÁTICAS DA PLATAFORMA
// A taxa é calculada pelo preço; o restante fica para o vendedor.
// Valores podem ser alterados no arquivo .env.
// ============================================================
const MAKETIPLACE_NOME = String(process.env.MAKETIPLACE_NOME || "maketiplace").trim();
const TAXA_BAIXO_LIMITE = Number(process.env.TAXA_BAIXO_LIMITE || 20);
const TAXA_ALTO_LIMITE = Number(process.env.TAXA_ALTO_LIMITE || 900);
const TAXA_MUITO_ALTO_LIMITE = Number(process.env.TAXA_MUITO_ALTO_LIMITE || 500);
const TAXA_BAIXO_PERCENTUAL = Number(process.env.TAXA_BAIXO_PERCENTUAL || 5);
const TAXA_ALTO_PERCENTUAL = Number(process.env.TAXA_ALTO_PERCENTUAL || 8);
const TAXA_MUITO_ALTO_PERCENTUAL = Number(process.env.TAXA_MUITO_ALTO_PERCENTUAL || 12);
const TAXA_ALTO_DEMAIS_PERCENTUAL = Number(process.env.TAXA_ALTO_DEMAIS_PERCENTUAL || 15);

function calcularTaxaMaketiplace(preco) {
    let faixa;
    let percentual;
    if (preco <= TAXA_BAIXO_LIMITE) {
        faixa = "baixo";
        percentual = TAXA_BAIXO_PERCENTUAL;
    } else if (preco <= TAXA_ALTO_LIMITE) {
        faixa = "alto";
        percentual = TAXA_ALTO_PERCENTUAL;
    } else if (preco <= TAXA_MUITO_ALTO_LIMITE) {
        faixa = "muito_alto";
        percentual = TAXA_MUITO_ALTO_PERCENTUAL;
    } else {
        faixa = "alto_demais";
        percentual = TAXA_ALTO_DEMAIS_PERCENTUAL;
    }
    const taxa = Number((preco * percentual / 100).toFixed(2));
    return { faixa, percentual, taxa, vendedorRecebe: Number((preco - taxa).toFixed(2)) };
}

function firebasePath(caminho) {
    return `${FIREBASE_DATABASE_URL}/${String(caminho).replace(/^\/+/, "")}.json`;
}

// ============================================================
// FIREBASE REST
// ============================================================

async function firebaseRequest(caminho, method = "GET", dados) {
    const options = {
        method,
        headers: { "Content-Type": "application/json" }
    };

    if (dados !== undefined) options.body = JSON.stringify(dados);

    const resposta = await fetch(firebasePath(caminho), options);
    const bruto = await resposta.text();
    let data = null;

    if (bruto) {
        try { data = JSON.parse(bruto); }
        catch { data = bruto; }
    }

    if (!resposta.ok) {
        throw new Error(`Firebase ${method} ${resposta.status}: ${bruto}`);
    }

    return data;
}

const firebaseGet = caminho => firebaseRequest(caminho, "GET");
const firebaseSet = (caminho, dados) => firebaseRequest(caminho, "PUT", dados);
const firebasePatch = (caminho, dados) => firebaseRequest(caminho, "PATCH", dados);
const firebaseDelete = caminho => firebaseRequest(caminho, "DELETE");

// Leitura com ETag para permitir operações condicionais no Realtime Database.
async function firebaseGetWithETag(caminho) {
    const resposta = await fetch(firebasePath(caminho), {
        method: "GET",
        headers: { "X-Firebase-ETag": "true" }
    });

    const bruto = await resposta.text();
    let data = null;
    if (bruto) {
        try { data = JSON.parse(bruto); }
        catch { data = bruto; }
    }

    if (!resposta.ok) {
        throw new Error(`Firebase GET ETag ${resposta.status}: ${bruto}`);
    }

    return { data, etag: resposta.headers.get("etag") || null };
}

// PUT condicional: só grava se o ETag ainda for o mesmo.
// Quando o nó não existe, o Firebase retorna o ETag especial null_etag;
// isso transforma a operação em um verdadeiro "criar se não existir".
async function firebasePutIfMatch(caminho, dados, etag) {
    const resposta = await fetch(firebasePath(caminho), {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "If-Match": etag || "null_etag"
        },
        body: JSON.stringify(dados)
    });

    const bruto = await resposta.text();
    let data = null;
    if (bruto) {
        try { data = JSON.parse(bruto); }
        catch { data = bruto; }
    }

    if (resposta.status === 412) {
        return { ok: false, conflito: true, data };
    }

    if (!resposta.ok) {
        throw new Error(`Firebase PUT condicional ${resposta.status}: ${bruto}`);
    }

    return { ok: true, conflito: false, data };
}

async function firebaseCreateIfAbsent(caminho, dados) {
    const atual = await firebaseGetWithETag(caminho);
    if (atual.data !== null && atual.data !== undefined) {
        return { criado: false, existente: atual.data };
    }

    const resultado = await firebasePutIfMatch(caminho, dados, atual.etag);
    if (!resultado.ok && resultado.conflito) {
        const depois = await firebaseGet(caminho);
        return { criado: false, existente: depois };
    }

    return { criado: true, existente: resultado.data };
}

// ============================================================
// AUTORIZAÇÃO DO ADMINISTRADOR
// ============================================================

async function validarAdminToken(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return false;

    const resposta = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: token })
        }
    );

    if (!resposta.ok) return false;
    const data = await resposta.json().catch(() => ({}));
    const usuario = data?.users?.[0];
    return Boolean(usuario?.email && String(usuario.email).toLowerCase() === ADMIN_EMAIL);
}

async function enviarEmailReembolso({
    email,
    nome = "Cliente",
    produto = "Produto",
    valor = 0,
    pagamentoId = "",
    pedidoId = "",
    reembolsoId = "",
    aprovado = true,
    motivo = ""
}) {
    if (!smtpConfigurado) return { enviado:false, erro:"SMTP não configurado." };
    const destinatario = texto(email).toLowerCase();
    if (!destinatario) return { enviado:false, erro:"E-mail do comprador não encontrado." };

    const valorFormatado = Number(valor || 0).toLocaleString("pt-BR", { style:"currency", currency:"BRL" });
    const dataFormatada = new Date().toLocaleString("pt-BR", { dateStyle:"short", timeStyle:"medium" });
    const nomeSeguro = escapeHtml(nome || "Cliente");
    const produtoSeguro = escapeHtml(produto || "Produto");
    const pagamentoSeguro = escapeHtml(pagamentoId || "-");
    const pedidoSeguro = escapeHtml(pedidoId || "-");
    const reembolsoSeguro = escapeHtml(reembolsoId || "-");
    const motivoSeguro = escapeHtml(motivo || "Solicitação analisada pelo administrador.");

    const assunto = aprovado
        ? "Reembolso aprovado — sua compra foi reembolsada"
        : "Reembolso recusado — atualização da sua solicitação";

    const textoEmail = aprovado
        ? [
            `Olá, ${nome || "Cliente"}!`,
            "",
            "Seu pedido de reembolso foi APROVADO pelo administrador.",
            "O estorno foi processado pelo Mercado Pago.",
            `Produto: ${produto || "Produto"}`,
            `Valor do reembolso: ${valorFormatado}`,
            `Pagamento: ${pagamentoId || "-"}`,
            `Pedido: ${pedidoId || "-"}`,
            `Reembolso: ${reembolsoId || "-"}`,
            `Data: ${dataFormatada}`,
            "",
            "A licença associada à compra foi marcada como reembolsada.",
            "Guarde este e-mail como comprovante do processamento do reembolso.",
            "",
            "Equipe da Loja"
        ].join("\n")
        : [
            `Olá, ${nome || "Cliente"}!`,
            "",
            "Seu pedido de reembolso foi RECUSADO pelo administrador.",
            `Motivo informado: ${motivo || "Solicitação recusada pelo administrador."}`,
            `Produto: ${produto || "Produto"}`,
            `Valor da compra: ${valorFormatado}`,
            `Pagamento: ${pagamentoId || "-"}`,
            `Pedido: ${pedidoId || "-"}`,
            `Solicitação de reembolso: ${reembolsoId || "-"}`,
            `Data: ${dataFormatada}`,
            "",
            "A compra permanece válida.",
            "",
            "Equipe da Loja"
        ].join("\n");

    const html = aprovado
        ? `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;padding:30px;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:650px;margin:auto;background:#fff;border-radius:18px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,.08)"><h1 style="margin-top:0;color:#16a34a">✅ Reembolso aprovado</h1><p>Olá, <strong>${nomeSeguro}</strong>!</p><p>Seu pedido de reembolso foi <strong>aprovado pelo administrador</strong> e o estorno foi processado pelo Mercado Pago.</p><div style="background:#f8fafc;border-radius:12px;padding:18px;margin:20px 0"><p><strong>Produto:</strong> ${produtoSeguro}</p><p><strong>Valor do reembolso:</strong> ${valorFormatado}</p><p><strong>Pagamento:</strong> ${pagamentoSeguro}</p><p><strong>Pedido:</strong> ${pedidoSeguro}</p><p><strong>ID do reembolso:</strong> ${reembolsoSeguro}</p><p><strong>Data:</strong> ${escapeHtml(dataFormatada)}</p></div><p>A licença associada a esta compra foi marcada como <strong>reembolsada</strong>.</p><p style="font-size:13px;color:#64748b">Guarde este e-mail como comprovante do processamento do reembolso.</p><p>Equipe da Loja</p></div></body></html>`
        : `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;padding:30px;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:650px;margin:auto;background:#fff;border-radius:18px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,.08)"><h1 style="margin-top:0;color:#dc2626">❌ Reembolso recusado</h1><p>Olá, <strong>${nomeSeguro}</strong>.</p><p>Seu pedido de reembolso foi <strong>recusado pelo administrador</strong>.</p><div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:18px;margin:20px 0"><p><strong>Motivo:</strong> ${motivoSeguro}</p><p><strong>Produto:</strong> ${produtoSeguro}</p><p><strong>Valor da compra:</strong> ${valorFormatado}</p><p><strong>Pedido:</strong> ${pedidoSeguro}</p><p><strong>Solicitação:</strong> ${reembolsoSeguro}</p><p><strong>Data:</strong> ${escapeHtml(dataFormatada)}</p></div><p>A compra permanece válida e não houve estorno do pagamento.</p><p>Equipe da Loja</p></div></body></html>`;

    await emailTransporter.sendMail({
        from: EMAIL_FROM,
        to: destinatario,
        subject: assunto,
        text: textoEmail,
        html
    });

    return { enviado:true, erro:"" };
}

async function enviarEmailVendedor({ vendedor, aprovado, motivo = "" }) {
    if (!smtpConfigurado) return false;
    const email = texto(vendedor?.email).toLowerCase();
    if (!email) return false;

    const link = `${PUBLIC_URL}/login-vendedor?vendedorId=${encodeURIComponent(vendedor.id)}`;
    const nome = escapeHtml(vendedor.nome || "Vendedor");

    const assunto = aprovado
        ? "Seu cadastro de vendedor foi aprovado"
        : "Atualização do seu cadastro de vendedor";

    const html = aprovado
        ? `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:30px"><div style="max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:30px"><h1 style="color:#16a34a">Cadastro aprovado 🎉</h1><p>Olá, <strong>${nome}</strong>!</p><p>Seu cadastro de vendedor foi aprovado pelo administrador.</p><p>Use o botão abaixo para acessar sua Central do Vendedor:</p><p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 20px;border-radius:10px;font-weight:700">Acessar minha Central</a></p><p style="font-size:13px;color:#64748b">Se o botão não abrir, copie este endereço:<br>${escapeHtml(link)}</p></div></body></html>`
        : `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:30px"><div style="max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:30px"><h1 style="color:#dc2626">Cadastro não aprovado</h1><p>Olá, <strong>${nome}</strong>.</p><p>Seu cadastro de vendedor não foi aprovado neste momento.</p><p><strong>Motivo:</strong> ${escapeHtml(motivo || "Não informado.")}</p></div></body></html>`;

    await emailTransporter.sendMail({
        from: EMAIL_FROM,
        to: email,
        subject: assunto,
        text: aprovado
            ? `Olá, ${vendedor.nome || "Vendedor"}! Seu cadastro foi aprovado. Acesse: ${link}`
            : `Olá, ${vendedor.nome || "Vendedor"}. Seu cadastro não foi aprovado. Motivo: ${motivo || "Não informado."}`,
        html
    });

    return true;
}


// ============================================================
// APROVAÇÃO DE VENDEDORES + E-MAIL
// ============================================================

app.post("/api/admin/vendedores/:id/aprovar", async (req, res) => {
    try {
        if (!(await validarAdminToken(req))) {
            return res.status(403).json({ erro: "Acesso administrativo não autorizado." });
        }

        const id = texto(req.params.id);
        if (!id) return res.status(400).json({ erro: "Vendedor não informado." });

        const vendedor = await firebaseGet(`vendedores/${encodeURIComponent(id)}`);
        if (!vendedor) return res.status(404).json({ erro: "Vendedor não encontrado." });

        const agora = Date.now();
        const linkCentral = `${PUBLIC_URL}/central-do-vendedor?vendedorId=${encodeURIComponent(id)}`;
        const atualizado = {
            status: "aprovado",
            aprovado: true,
            aprovadoEm: agora,
            aprovadoPor: ADMIN_EMAIL,
            linkCentral,
            bloqueado: false,
            atualizadoEm: agora
        };

        await firebasePatch(`vendedores/${encodeURIComponent(id)}`, atualizado);
        await firebasePatch(`chatVendedores/${encodeURIComponent(id)}/perfil`, {
            ativo: true,
            atualizadoEm: agora
        });

        enviarAtualizacaoCentral(id, "central_atualizada");

        let emailEnviado = false;
        let emailErro = "";
        try {
            emailEnviado = await enviarEmailVendedor({ vendedor: { ...vendedor, id }, aprovado: true });
        } catch (erroEmail) {
            console.error("Erro ao enviar aprovação por e-mail:", erroEmail);
            emailErro = erroEmail.message || "Erro no SMTP.";
        }

        return res.json({ ok: true, vendedorId: id, linkCentral, emailEnviado, emailErro });
    } catch (erro) {
        console.error("Aprovação vendedor:", erro);
        return res.status(500).json({ erro: "Não foi possível aprovar o vendedor." });
    }
});

app.post("/api/admin/vendedores/:id/reprovar", async (req, res) => {
    try {
        if (!(await validarAdminToken(req))) {
            return res.status(403).json({ erro: "Acesso administrativo não autorizado." });
        }

        const id = texto(req.params.id);
        const motivo = texto(req.body?.motivo, "Cadastro recusado pelo administrador.");
        if (!id) return res.status(400).json({ erro: "Vendedor não informado." });

        const vendedor = await firebaseGet(`vendedores/${encodeURIComponent(id)}`);
        if (!vendedor) return res.status(404).json({ erro: "Vendedor não encontrado." });

        const agora = Date.now();
        await firebasePatch(`vendedores/${encodeURIComponent(id)}`, {
            status: "reprovado",
            aprovado: false,
            motivoReprovacao: motivo,
            reprovadoEm: agora,
            reprovadoPor: ADMIN_EMAIL,
            atualizadoEm: agora
        });

        await firebasePatch(`chatVendedores/${encodeURIComponent(id)}/perfil`, {
            ativo: false,
            atualizadoEm: agora
        });

        let emailEnviado = false;
        let emailErro = "";
        try {
            emailEnviado = await enviarEmailVendedor({ vendedor: { ...vendedor, id }, aprovado: false, motivo });
        } catch (erroEmail) {
            console.error("Erro ao enviar recusa por e-mail:", erroEmail);
            emailErro = erroEmail.message || "Erro no SMTP.";
        }

        return res.json({ ok: true, vendedorId: id, emailEnviado, emailErro });
    } catch (erro) {
        console.error("Reprovação vendedor:", erro);
        return res.status(500).json({ erro: "Não foi possível recusar o vendedor." });
    }
});

// ============================================================
// MERCADO PAGO
// ============================================================

async function mercadoPagoRequest(url, options = {}) {
    const resposta = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });

    const textoResposta = await resposta.text();
    let data = null;

    if (textoResposta) {
        try { data = JSON.parse(textoResposta); }
        catch { data = { resposta: textoResposta }; }
    }

    return { ok: resposta.ok, status: resposta.status, data };
}

async function obterTokenVendedor(vendedorId) {
    const id = texto(vendedorId);

    if (!id) return MP_ACCESS_TOKEN;

    const dados = await firebaseGet(`vendedores/${encodeURIComponent(id)}/mercadoPago`);

    if (dados?.conectado && dados?.access_token) return dados.access_token;

    return MP_ACCESS_TOKEN;
}

// ============================================================
// LICENÇAS
// ============================================================
// A chave é criada automaticamente somente após confirmação de
// pagamento aprovado. O vendedor não precisa criar nenhuma chave.
// ============================================================

function gerarCodigoLicenca() {
    const parteA = crypto.randomBytes(5).toString("hex").toUpperCase();
    const parteB = crypto.randomBytes(5).toString("hex").toUpperCase();
    const parteC = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${LICENCA_PREFIXO}-${parteA}-${parteB}-${parteC}`;
}

function hashLicenca(chave) {
    return crypto
        .createHmac("sha256", LICENCA_SALT)
        .update(String(chave))
        .digest("hex");
}

function criarIdLicenca() {
    return crypto.randomBytes(18).toString("hex");
}

async function criarLicencaParaCompra(compra) {
    if (!compra?.pedidoId) throw new Error("Pedido não informado para criar licença.");

    const caminhoCompra = `compras/${compra.pedidoId}`;
    const compraAtual = await firebaseGet(caminhoCompra);

    if (compraAtual?.licencaId) {
        const existente = await firebaseGet(`licencas/${compraAtual.licencaId}`);
        if (existente) return existente;
    }

    const pedidosExistente = await firebaseGet(`pedidos/${compra.pedidoId}`);
    if (pedidosExistente?.licencaId) {
        const existente = await firebaseGet(`licencas/${pedidosExistente.licencaId}`);
        if (existente) return existente;
    }

    if (compra.pagamentoId) {
        const pagamentoExistente = await firebaseGet(`pagamentos/${compra.pagamentoId}`);
        if (pagamentoExistente?.licencaId) {
            const existente = await firebaseGet(`licencas/${pagamentoExistente.licencaId}`);
            if (existente) return existente;
        }
    }

    const identificadorBase = String(compra.pagamentoId || compra.pedidoId);
    const chaveReserva = `processamentoPagamentos/${encodeURIComponent(identificadorBase)}`;
    const licencaId = crypto
        .createHash("sha256")
        .update(`licenca:${identificadorBase}`)
        .digest("hex")
        .slice(0, 40);

    // A reserva é feita com ETag/If-Match. Somente UMA requisição pode
    // criar o marcador quando o pagamento ainda não foi processado.
    const agoraReserva = Date.now();
    const reserva = await firebaseCreateIfAbsent(chaveReserva, {
        pagamentoId: texto(compra.pagamentoId),
        pedidoId: compra.pedidoId,
        licencaId,
        status: "processando",
        iniciadoEm: agoraReserva,
        atualizadoEm: agoraReserva
    });

    if (!reserva.criado) {
        const existente = reserva.existente;

        if (existente?.licencaId) {
            const licencaExistente = await firebaseGet(`licencas/${existente.licencaId}`);
            if (licencaExistente) {
                return { ...licencaExistente, __repetido: true };
            }
        }

        // Outra requisição ganhou a trava. Aguarda a primeira terminar e
        // procura a licença por alguns segundos, sem gerar outra chave.
        for (let tentativa = 0; tentativa < 20; tentativa++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const licencaPronta = await firebaseGet(`licencas/${licencaId}`);
            if (licencaPronta) {
                return { ...licencaPronta, __repetido: true };
            }

            const reservaAtual = await firebaseGet(chaveReserva);
            if (!reservaAtual) break;
        }

        throw new Error("Outro webhook ainda está processando este pagamento. O Mercado Pago poderá reenviar a notificação.");
    }

    const licencaExistente = await firebaseGet(`licencas/${licencaId}`);
    if (licencaExistente) return { ...licencaExistente, __repetido: true };

    const chave = gerarCodigoLicenca();
    const agora = Date.now();

    const licenca = {
        id: licencaId,
        chaveHash: hashLicenca(chave),
        produtoId: texto(compra.produtoId, texto(compra.id, "produto")),
        vendedorId: texto(compra.vendedorId),
        compradorId: texto(compra.compradorId),
        compradorEmail: texto(compra.compradorEmail),
        pedidoId: compra.pedidoId,
        pagamentoId: texto(compra.pagamentoId),
        status: "ativa",
        tipo: "por_compra",
        ativacoes: 0,
        dispositivoHash: null,
        criadaEm: agora,
        atualizadaEm: agora,
        transferidaEm: null,
        revogadaEm: null,
        chave
    };

    try {
        // O ID da licença é determinístico e a reserva já foi conquistada
        // atomicamente. Portanto nenhum webhook concorrente pode substituir
        // esta licença durante o processamento inicial.
        await firebaseSet(`licencas/${licencaId}`, licenca);

        await firebasePatch(caminhoCompra, {
            licencaId,
            licencaStatus: "ativa",
            licencaCriadaEm: agora
        });

        await firebasePatch(`pedidos/${compra.pedidoId}`, {
            licencaId,
            licencaStatus: "ativa",
            licencaCriadaEm: agora
        });

        await firebasePatch(`pagamentos/${compra.pagamentoId}`, {
            licencaId,
            licencaStatus: "ativa",
            licencaCriadaEm: agora
        });

        await firebasePatch(chaveReserva, {
            pagamentoId: texto(compra.pagamentoId),
            pedidoId: compra.pedidoId,
            licencaId,
            status: "concluido",
            concluidoEm: Date.now(),
            atualizadoEm: Date.now()
        });

        if (compra.compradorId) {
            await firebaseSet(
                `compradores/${compra.compradorId}/licencas/${licencaId}`,
                { licencaId, produtoId: licenca.produtoId, status: "ativa", criadaEm: agora }
            );
        }

        return licenca;
    } catch (erro) {
        // Mantém a reserva para que o próximo webhook não tente criar outra
        // licença enquanto esta execução falhou. O Mercado Pago reenviará a
        // notificação e o operador poderá observar o erro no terminal.
        console.error("Erro finalizando licença idempotente:", erro);
        throw erro;
    }
}
function hashDispositivo(dispositivoId) {
    if (!dispositivoId) return null;
    return crypto
        .createHmac("sha256", LICENCA_SALT)
        .update(String(dispositivoId))
        .digest("hex");
}

// ============================================================
// ROTA INICIAL / STATUS
// ============================================================

app.get("/", (req, res) => {
    const arquivo = path.join(__dirname, "loja.html");
    res.sendFile(arquivo, erro => {
        if (erro && !res.headersSent) {
            res.send(`
                <h1>LOJA DE APLICATIVOS</h1>
                <p>Servidor funcionando.</p>
                <p><a href="/central-do-vendedor">Central do Vendedor</a></p>
            `);
        }
    });
});

app.get("/status", (req, res) => {
    res.json({
        sucesso: true,
        servidor: "online",
        mercadoPago: Boolean(MP_ACCESS_TOKEN),
        oauth: true,
        pkce: true,
        firebase: true,
        licencas: true,
        licencaAutomaticaPorCompra: true,
        redirect_uri: MP_REDIRECT_URI,
        porta: PORTA,
        horario: new Date().toISOString()
    });
});

// ============================================================
// MERCADO PAGO OAUTH — INICIAR
// ============================================================

app.get("/mercadopago/conectar", (req, res) => {
    try {
        limparSessoesOAuth();

        const vendedorId = texto(req.query.vendedorId);
        if (!vendedorId) return res.status(400).send("Vendedor não identificado.");

        const codeVerifier = gerarCodeVerifier();
        const codeChallenge = gerarCodeChallenge(codeVerifier);
        const state = gerarState();

        oauthSessions.set(state, {
            vendedorId,
            codeVerifier,
            criadoEm: Date.now()
        });

        const parametros = new URLSearchParams({
            response_type: "code",
            client_id: MP_CLIENT_ID,
            redirect_uri: MP_REDIRECT_URI,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256"
        });

        res.redirect(`https://auth.mercadopago.com/authorization?${parametros.toString()}`);
    } catch (erro) {
        console.error("ERRO AO INICIAR OAUTH:", erro);
        res.status(500).send("Erro ao iniciar conexão com Mercado Pago.");
    }
});

// ============================================================
// MERCADO PAGO OAUTH — CALLBACK
// ============================================================

app.get("/mercadopago/callback", async (req, res) => {
    try {
        const code = texto(req.query.code);
        const state = texto(req.query.state);
        const erro = texto(req.query.error);
        const erroDescricao = texto(req.query.error_description);

        if (erro) {
            return res.status(400).send(`
                <h2>Erro Mercado Pago</h2>
                <p>${escapeHtml(erroDescricao || erro)}</p>
                <p><a href="/central-do-vendedor">Voltar para Central</a></p>
            `);
        }

        if (!code || !state) {
            return res.status(400).send(`
                <h2>Dados OAuth incompletos.</h2>
                <a href="/central-do-vendedor">Voltar para Central</a>
            `);
        }

        const sessao = oauthSessions.get(state);
        if (!sessao) {
            return res.status(400).send(`
                <h2>Sessão OAuth expirada.</h2>
                <p>Clique novamente em Conectar Mercado Pago.</p>
                <a href="/central-do-vendedor">Voltar para Central</a>
            `);
        }

        oauthSessions.delete(state);

        const respostaToken = await mercadoPagoRequest(
            "https://api.mercadopago.com/oauth/token",
            {
                method: "POST",
                body: JSON.stringify({
                    client_id: MP_CLIENT_ID,
                    client_secret: MP_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: MP_REDIRECT_URI,
                    code_verifier: sessao.codeVerifier
                })
            }
        );

        if (!respostaToken.ok || !respostaToken.data?.access_token) {
            console.error("ERRO OAUTH:", respostaToken.status, respostaToken.data);
            return res.status(500).send(`
                <h2>Erro ao conectar Mercado Pago</h2>
                <p>HTTP: ${respostaToken.status}</p>
                <a href="/central-do-vendedor">Voltar para Central</a>
            `);
        }

        const token = respostaToken.data;
        const agora = Date.now();

        await firebaseSet(`vendedores/${sessao.vendedorId}/mercadoPago`, {
            conectado: true,
            user_id: token.user_id || null,
            public_key: token.public_key || null,
            access_token: token.access_token,
            refresh_token: token.refresh_token || null,
            token_type: token.token_type || "bearer",
            expires_in: token.expires_in || null,
            scope: token.scope || null,
            conectadoEm: agora,
            atualizadoEm: agora
        });

        res.redirect(`/central-do-vendedor?mercadopago=conectado&vendedorId=${encodeURIComponent(sessao.vendedorId)}`);
    } catch (erro) {
        console.error("ERRO INTERNO CALLBACK:", erro);
        res.status(500).send(`
            <h2>Erro interno no servidor.</h2>
            <a href="/central-do-vendedor">Voltar para Central</a>
        `);
    }
});

// ============================================================
// STATUS DO VENDEDOR
// ============================================================

app.get("/api/vendedor/:vendedorId", async (req, res) => {
    try {
        const vendedorId = texto(req.params.vendedorId);
        if (!vendedorId) return res.status(400).json({ sucesso: false, conectado: false });

        const dados = await firebaseGet(`vendedores/${vendedorId}/mercadoPago`);

        res.json({
            sucesso: true,
            conectado: Boolean(dados?.conectado && dados?.access_token),
            vendedorId,
            mercadoPago: dados ? {
                conectado: Boolean(dados.conectado && dados.access_token),
                user_id: dados.user_id || null,
                conectadoEm: dados.conectadoEm || null,
                atualizadoEm: dados.atualizadoEm || null
            } : null
        });
    } catch (erro) {
        console.error("ERRO STATUS VENDEDOR:", erro);
        res.status(500).json({ sucesso: false, conectado: false, erro: "Erro ao consultar Firebase." });
    }
});

// ============================================================
// DESCONECTAR MERCADO PAGO
// ============================================================

app.delete("/api/vendedor/:vendedorId/mercadopago", async (req, res) => {
    try {
        const vendedorId = texto(req.params.vendedorId);
        if (!vendedorId) return res.status(400).json({ sucesso: false, erro: "Vendedor não informado." });

        await firebaseSet(`vendedores/${vendedorId}/mercadoPago`, {
            conectado: false,
            desconectadoEm: Date.now()
        });

        res.json({ sucesso: true, conectado: false });
    } catch (erro) {
        console.error("ERRO DESCONECTANDO:", erro);
        res.status(500).json({ sucesso: false, erro: erro.message });
    }
});

// ============================================================
// TESTAR TOKEN DO VENDEDOR
// ============================================================

app.get("/api/vendedor/:vendedorId/mercadopago/testar", async (req, res) => {
    try {
        const vendedorId = texto(req.params.vendedorId);
        const dados = await firebaseGet(`vendedores/${vendedorId}/mercadoPago`);

        if (!dados?.access_token) return res.json({ conectado: false, valido: false });

        const resposta = await mercadoPagoRequest("https://api.mercadopago.com/v1/users/me", {
            headers: { Authorization: `Bearer ${dados.access_token}` }
        });

        if (!resposta.ok) {
            return res.json({ conectado: true, valido: false, status: resposta.status, erro: resposta.data });
        }

        res.json({ conectado: true, valido: true, usuario: resposta.data });
    } catch (erro) {
        console.error("ERRO TESTANDO TOKEN:", erro);
        res.status(500).json({ conectado: false, valido: false, erro: erro.message });
    }
});


// ============================================================
// CONFIGURAÇÃO PÚBLICA DO CHECKOUT
// A Public Key pode ser enviada ao navegador; nunca envie Access Token.
// ============================================================
app.get("/api/config/pagamento", (_req, res) => {
    const publicKey = MP_PAYMENT_PUBLIC_KEY;

    if (!publicKey) {
        return res.status(503).json({
            sucesso: false,
            codigo: "MP_PUBLIC_KEY_NAO_CONFIGURADA",
            erro: "A Public Key do Mercado Pago da plataforma não está configurada. Adicione a Public Key de pagamento no arquivo .env e reinicie o servidor."
        });
    }

    res.set("Cache-Control", "no-store");
    res.json({ sucesso: true, publicKey });
});

// ============================================================
// CHECKOUT TRANSPARENTE — CARTÃO
// ============================================================
app.post("/preparar-pagamento-cartao", async (req, res) => {
    try {
        const vendedorId = texto(req.body.vendedorId);
        const produtoId = texto(req.body.produtoId || req.body.id, "produto-001");
        const compradorId = texto(req.body.compradorId || req.body.clienteId);
        const compradorEmail = texto(req.body.compradorEmail || req.body.email).toLowerCase();
        const titulo = texto(req.body.titulo || req.body.nome, "Produto");
        const preco = normalizarPreco(req.body.preco);
        const imagem = texto(req.body.imagem || req.body.imagemUrl);
        const pedidoInformado = texto(req.body.pedido_id || req.body.pedidoId);
        const pedidoId = /^[A-Za-z0-9._-]{1,100}$/.test(pedidoInformado)
            ? pedidoInformado
            : `pedido-cartao-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;

        if (!vendedorId) return res.status(400).json({ sucesso:false, erro:"vendedorId é obrigatório." });
        if (!preco) return res.status(400).json({ sucesso:false, erro:"Preço inválido." });

        const vendedorMP = await firebaseGet(`vendedores/${vendedorId}/mercadoPago`);
        if (!MP_TEST_MODE && (!vendedorMP?.conectado || !vendedorMP?.access_token)) {
            return res.status(403).json({ sucesso:false, bloqueado:true, codigo:"MERCADO_PAGO_NAO_CONECTADO", erro:"O vendedor precisa conectar o Mercado Pago antes de vender aplicativos." });
        }
        if (MP_TEST_MODE && !MP_PAYMENT_ACCESS_TOKEN) {
            return res.status(503).json({ sucesso:false, codigo:"MP_TEST_CREDENTIALS_MISSING", erro:"Modo TESTE ativo, mas MP_TEST_ACCESS_TOKEN não foi configurado." });
        }

        // Para Checkout Transparente em marketplace, a documentação do Mercado Pago
        // recomenda a Public Key da conta integradora no frontend e o access_token do
        // vendedor no backend.
        const publicKey = MP_PAYMENT_PUBLIC_KEY;
        if (!publicKey) {
            return res.status(503).json({ sucesso:false, codigo:"MP_PUBLIC_KEY_NAO_CONFIGURADA", erro:"A Public Key do Mercado Pago da plataforma não está configurada no servidor." });
        }

        const calculoTaxa = calcularTaxaMaketiplace(preco);
        await firebaseSet(`pedidos/${pedidoId}`, {
            id:pedidoId, produtoId, vendedorId,
            compradorId:compradorId || null,
            compradorEmail:compradorEmail || null,
            titulo, preco, imagem:imagem || null,
            plataforma:MAKETIPLACE_NOME,
            taxaPlataforma:calculoTaxa.taxa,
            taxaPercentual:calculoTaxa.percentual,
            faixaTaxa:calculoTaxa.faixa,
            vendedorRecebe:calculoTaxa.vendedorRecebe,
            formaPagamento:"cartao",
            status:"aguardando_pagamento",
            criadoEm:Date.now()
        });

        res.json({ sucesso:true, pedidoId, publicKey, amount:preco, taxa:calculoTaxa.taxa, taxaPercentual:calculoTaxa.percentual });
    } catch (erro) {
        console.error("ERRO PREPARANDO CARTÃO:", erro);
        res.status(500).json({ sucesso:false, erro:erro.message });
    }
});

app.post("/processar-pagamento-cartao", async (req, res) => {
    try {
        const pedidoId = texto(req.body.pedidoId);
        const token = texto(req.body.token);
        const paymentMethodId = texto(req.body.payment_method_id);
        const installments = Math.max(1, Number(req.body.installments || 1));
        const issuerId = texto(req.body.issuer_id);
        const payer = req.body.payer && typeof req.body.payer === "object" ? req.body.payer : {};

        if (!pedidoId || !token || !paymentMethodId) {
            return res.status(400).json({ sucesso:false, erro:"Dados do cartão incompletos." });
        }

        const pedido = await firebaseGet(`pedidos/${encodeURIComponent(pedidoId)}`);
        if (!pedido?.id) return res.status(404).json({ sucesso:false, erro:"Pedido não encontrado." });
        if (pedido.status === "pago" && pedido.licencaId) {
            return res.json({ sucesso:true, aprovado:true, repetido:true, licencaId:pedido.licencaId, pedidoId });
        }

        const vendedorMP = await firebaseGet(`vendedores/${encodeURIComponent(pedido.vendedorId)}/mercadoPago`);
        if (!MP_TEST_MODE && (!vendedorMP?.conectado || !vendedorMP?.access_token)) {
            return res.status(403).json({ sucesso:false, erro:"O vendedor não está conectado ao Mercado Pago." });
        }

        const email = texto(payer.email || pedido.compradorEmail).toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ sucesso:false, erro:"Informe um e-mail válido." });
        }

        const calculoTaxa = calcularTaxaMaketiplace(Number(pedido.preco));
        const idempotencyKey = texto(req.headers["x-idempotency-key"]) || crypto.randomUUID();
        const corpo = {
            transaction_amount:Number(Number(pedido.preco).toFixed(2)),
            token,
            description:texto(pedido.titulo, "Produto"),
            installments,
            payment_method_id:paymentMethodId,
            payer:{
                email,
                ...(payer.identification?.type && payer.identification?.number ? { identification:{ type:String(payer.identification.type), number:String(payer.identification.number) } } : {})
            },
            external_reference:String(pedidoId).slice(0,100),
            notification_url:process.env.MP_WEBHOOK_URL || `${PUBLIC_URL}/webhook/mercadopago`
        };
        if (issuerId) corpo.issuer_id = Number.isFinite(Number(issuerId)) ? Number(issuerId) : issuerId;

        // A taxa de marketplace só é enviada quando explicitamente habilitada.
        // Isso evita o erro "You cannot use application_fee with this payment" em contas/meios
        // que não aceitam application_fee. Para ativar, use MP_USAR_APPLICATION_FEE=true no .env.
        if (String(process.env.MP_USAR_APPLICATION_FEE || "false").toLowerCase() === "true") {
            corpo.application_fee = Number(calculoTaxa.taxa.toFixed(2));
        }

        const resposta = await mercadoPagoRequest("https://api.mercadopago.com/v1/payments", {
            method:"POST",
            headers:{ Authorization:`Bearer ${MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : vendedorMP.access_token}`, "Content-Type":"application/json", "X-Idempotency-Key":idempotencyKey },
            body:JSON.stringify(corpo)
        });

        if (!resposta.ok) {
            await firebasePatch(`pedidos/${encodeURIComponent(pedidoId)}`, { status:"erro_pagamento", erroPagamento:resposta.data, atualizadoEm:Date.now() });
            return res.status(resposta.status).json({ sucesso:false, erro:resposta.data?.message || resposta.data?.error || "Mercado Pago recusou o pagamento." });
        }

        const pagamento = resposta.data;
        await firebaseSet(`pagamentos/${String(pagamento.id)}`, {
            id:String(pagamento.id), pedidoId, produtoId:pedido.produtoId, vendedorId:pedido.vendedorId,
            compradorId:pedido.compradorId || null, compradorEmail:email,
            status:pagamento.status || "pending", statusDetail:pagamento.status_detail || null,
            transactionAmount:pagamento.transaction_amount || Number(pedido.preco),
            paymentMethodId:pagamento.payment_method_id || paymentMethodId,
            installments:pagamento.installments || installments,
            formaPagamento:"cartao", taxaPlataforma:calculoTaxa.taxa,
            taxaPercentual:calculoTaxa.percentual, vendedorRecebe:calculoTaxa.vendedorRecebe,
            criadoEm:Date.now(), atualizadoEm:Date.now()
        });
        await firebasePatch(`pedidos/${encodeURIComponent(pedidoId)}`, {
            compradorEmail:email, pagamentoId:String(pagamento.id), status:pagamento.status === "approved" ? "pago" : "aguardando_pagamento", atualizadoEm:Date.now()
        });

        res.json({ sucesso:true, pedidoId, pagamentoId:String(pagamento.id), status:pagamento.status, statusDetail:pagamento.status_detail || null, aprovado:pagamento.status === "approved" });
    } catch (erro) {
        console.error("ERRO PAGAMENTO CARTÃO:", erro);
        res.status(500).json({ sucesso:false, erro:erro.message });
    }
});

// ============================================================
// CRIAR PAGAMENTO
// ============================================================
// external_reference contém o pedido para o webhook localizar
// produto, comprador e vendedor e gerar a licença automaticamente.
// ============================================================

app.post("/criar-pagamento", async (req, res) => {
    try {
        const vendedorId = texto(req.body.vendedorId);
        const produtoId = texto(req.body.produtoId || req.body.id, "produto-001");
        const compradorId = texto(req.body.compradorId || req.body.clienteId);
        const compradorEmail = texto(req.body.compradorEmail || req.body.email);
        const pedidoInformado = texto(req.body.pedido_id || req.body.pedidoId);
        const pedidoId = /^[A-Za-z0-9._-]{1,100}$/.test(pedidoInformado)
            ? pedidoInformado
            : `pedido-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
        const titulo = texto(req.body.titulo || req.body.nome, "Produto");
        const preco = normalizarPreco(req.body.preco);
        const calculoTaxa = preco ? calcularTaxaMaketiplace(preco) : null;

        if (!preco) return res.status(400).json({ sucesso: false, erro: "Preço inválido." });
        if (!vendedorId) return res.status(400).json({ sucesso: false, erro: "vendedorId é obrigatório." });

        // Regra principal: vendedor só vende se Mercado Pago estiver conectado.
        const vendedorMP = await firebaseGet(`vendedores/${vendedorId}/mercadoPago`);
        if (!vendedorMP?.conectado || !vendedorMP?.access_token) {
            return res.status(403).json({
                sucesso: false,
                bloqueado: true,
                codigo: "MERCADO_PAGO_NAO_CONECTADO",
                erro: "O vendedor precisa conectar o Mercado Pago antes de vender aplicativos."
            });
        }

        const accessToken = MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : (vendedorMP.access_token || MP_ACCESS_TOKEN);
        if (!accessToken) return res.status(400).json({ sucesso: false, erro: "Nenhum Access Token disponível." });

        // Salva o pedido antes de criar a preferência.
        await firebaseSet(`pedidos/${pedidoId}`, {
            id: pedidoId,
            produtoId,
            vendedorId,
            compradorId: compradorId || null,
            compradorEmail: compradorEmail || null,
            titulo,
            preco,
            plataforma: MAKETIPLACE_NOME,
            taxaPlataforma: calculoTaxa.taxa,
            taxaPercentual: calculoTaxa.percentual,
            faixaTaxa: calculoTaxa.faixa,
            vendedorRecebe: calculoTaxa.vendedorRecebe,
            status: "aguardando_pagamento",
            criadoEm: Date.now()
        });

        // O Mercado Pago aceita um identificador curto em external_reference.
        // Os demais dados ficam no Firebase vinculados ao pedido.
        const externalReference = String(pedidoId).slice(0, 100);

        const resposta = await mercadoPagoRequest(
            "https://api.mercadopago.com/checkout/preferences",
            {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({
                    items: [{
                        id: produtoId,
                        title: titulo,
                        quantity: 1,
                        unit_price: preco,
                        currency_id: "BRL"
                    }],
                    external_reference: externalReference,
                    marketplace_fee: calculoTaxa.taxa,
                    back_urls: {
                        success: process.env.MP_SUCCESS_URL || `${PUBLIC_URL}/pagamento?status=success`,
                        failure: process.env.MP_FAILURE_URL || `${PUBLIC_URL}/pagamento?status=failure`,
                        pending: process.env.MP_PENDING_URL || `${PUBLIC_URL}/pagamento?status=pending`
                    },
                    auto_return: "approved",
                    notification_url: process.env.MP_WEBHOOK_URL || `${PUBLIC_URL}/webhook/mercadopago`
                })
            }
        );

        if (!resposta.ok) {
            await firebasePatch(`pedidos/${pedidoId}`, {
                status: "erro_pagamento",
                erroPagamento: resposta.data,
                atualizadoEm: Date.now()
            });
            return res.status(resposta.status).json({ sucesso: false, erro: resposta.data });
        }

        await firebasePatch(`pedidos/${pedidoId}`, {
            preferenceId: resposta.data.id,
            status: "aguardando_pagamento",
            atualizadoEm: Date.now()
        });

        res.json({
            sucesso: true,
            pedidoId,
            id: resposta.data.id,
            init_point: resposta.data.init_point,
            sandbox_init_point: resposta.data.sandbox_init_point || null,
            plataforma: MAKETIPLACE_NOME,
            taxa: calculoTaxa.taxa,
            taxaPercentual: calculoTaxa.percentual,
            faixaTaxa: calculoTaxa.faixa,
            vendedorRecebe: calculoTaxa.vendedorRecebe
        });
    } catch (erro) {
        console.error("ERRO PAGAMENTO:", erro);
        res.status(500).json({ sucesso: false, erro: erro.message });
    }
});


// ============================================================
// PIX DIRETO — QR CODE + COPIA E COLA
// ============================================================
app.post("/criar-pix", async (req, res) => {
    try {
        const vendedorId = texto(req.body.vendedorId);
        const produtoId = texto(req.body.produtoId || req.body.id, "produto-001");
        const usuarioPix = await usuarioFirebaseDoToken(req);
        if (!usuarioPix?.localId) return res.status(401).json({ sucesso:false, erro:"Entre na sua conta para comprar." });
        const compradorIdAutenticado = usuarioPix.localId;
        const compradorId = compradorIdAutenticado;
        const compradorEmail = texto(usuarioPix.email).toLowerCase();
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(produtoId)) return res.status(400).json({ sucesso:false, erro:"Produto inválido." });
        const produtoOriginal = await firebaseGet(`produtos/${produtoId}`);
        if (!produtoOriginal) return res.status(404).json({ sucesso:false, erro:"Produto não encontrado." });
        const titulo = texto(produtoOriginal.nome || produtoOriginal.nomeApp, "Produto");
        const preco = normalizarPreco(produtoOriginal.preco);
        if (String(produtoOriginal.vendedorId || "") !== vendedorId) return res.status(400).json({ sucesso:false, erro:"Vendedor não corresponde ao produto." });
        const imagem = texto(req.body.imagem || req.body.imagemUrl);
        const pedidoInformado = texto(req.body.pedido_id || req.body.pedidoId);
        const pedidoId = /^[A-Za-z0-9._-]{1,100}$/.test(pedidoInformado)
            ? pedidoInformado
            : `pedido-pix-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;

        if (!vendedorId) return res.status(400).json({ sucesso:false, erro:"vendedorId é obrigatório." });
        if (!preco) return res.status(400).json({ sucesso:false, erro:"Preço inválido." });
        if (!compradorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(compradorEmail)) {
            return res.status(400).json({ sucesso:false, erro:"Informe um e-mail válido para gerar o PIX." });
        }

        const vendedorMP = await firebaseGet(`vendedores/${vendedorId}/mercadoPago`);
        if (!MP_TEST_MODE && (!vendedorMP?.conectado || !vendedorMP?.access_token)) {
            return res.status(403).json({
                sucesso:false, bloqueado:true, codigo:"MERCADO_PAGO_NAO_CONECTADO",
                erro:"O vendedor precisa conectar o Mercado Pago antes de vender aplicativos."
            });
        }
        if (MP_TEST_MODE && !MP_PAYMENT_ACCESS_TOKEN) {
            return res.status(503).json({ sucesso:false, codigo:"MP_TEST_CREDENTIALS_MISSING", erro:"Modo TESTE ativo, mas MP_TEST_ACCESS_TOKEN não foi configurado." });
        }

        const calculoTaxa = calcularTaxaMaketiplace(preco);

        await firebaseSet(`pedidos/${pedidoId}`, {
            id:pedidoId, produtoId, vendedorId,
            compradorId:compradorId || null, compradorEmail,
            titulo, preco, imagem:imagem || null,
            plataforma:MAKETIPLACE_NOME,
            taxaPlataforma:calculoTaxa.taxa,
            taxaPercentual:calculoTaxa.percentual,
            faixaTaxa:calculoTaxa.faixa,
            vendedorRecebe:calculoTaxa.vendedorRecebe,
            formaPagamento:"pix", status:"aguardando_pagamento", criadoEm:Date.now()
        });

        // IMPORTANTE: nunca coloque o JSON completo do pedido aqui.
        // external_reference deve ser apenas o ID curto usado pelo webhook.
        const externalReference = String(pedidoId).slice(0, 100);

        const resposta = await mercadoPagoRequest("https://api.mercadopago.com/v1/payments", {
            method:"POST",
            headers:{
                Authorization:`Bearer ${MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : vendedorMP.access_token}`,
                "Content-Type":"application/json",
                "X-Idempotency-Key":crypto.randomUUID()
            },
            body:JSON.stringify({
                transaction_amount:Number(preco.toFixed(2)),
                description:titulo,
                payment_method_id:"pix",
                external_reference:externalReference,
                payer:{email:compradorEmail},
                notification_url:process.env.MP_WEBHOOK_URL || `${PUBLIC_URL}/webhook/mercadopago`
            })
        });

        if (!resposta.ok) {
            await firebasePatch(`pedidos/${pedidoId}`, {
                status:"erro_pagamento", erroPagamento:resposta.data, atualizadoEm:Date.now()
            });
            return res.status(resposta.status).json({
                sucesso:false,
                erro:resposta.data?.message || resposta.data?.error || "Mercado Pago recusou a criação do PIX."
            });
        }

        const pagamento = resposta.data;
        const dadosPix = pagamento?.point_of_interaction?.transaction_data;

        if (!dadosPix?.qr_code || !dadosPix?.qr_code_base64) {
            return res.status(502).json({
                sucesso:false,
                erro:"O Mercado Pago não retornou os dados do QR Code PIX."
            });
        }

        await firebaseSet(`pagamentos/${String(pagamento.id)}`, {
            id:String(pagamento.id),
            pedidoId,
            vendedorId,
            produtoId,
            status:pagamento.status || "pending",
            criadoEm:Date.now(),
            atualizadoEm:Date.now()
        });

        await firebasePatch(`pedidos/${pedidoId}`, {
            pagamentoId:String(pagamento.id),
            pix:{
                qrCode:dadosPix.qr_code,
                qrCodeBase64:dadosPix.qr_code_base64,
                ticketUrl:dadosPix.ticket_url || null
            },
            status:pagamento.status || "pending",
            atualizadoEm:Date.now()
        });

        res.json({
            sucesso:true, pedidoId, pagamentoId:String(pagamento.id),
            status:pagamento.status || "pending",
            statusDetail:pagamento.status_detail || null,
            qrCode:dadosPix.qr_code,
            qrCodeBase64:dadosPix.qr_code_base64,
            ticketUrl:dadosPix.ticket_url || null,
            taxa:calculoTaxa.taxa,
            taxaPercentual:calculoTaxa.percentual,
            vendedorRecebe:calculoTaxa.vendedorRecebe
        });
    } catch (erro) {
        console.error("ERRO PIX:",erro);
        res.status(500).json({ sucesso:false, erro:erro.message || "Erro interno ao criar PIX." });
    }
});

// ============================================================
// CONSULTAR STATUS DO PIX
// ============================================================
app.get("/api/pagamento/:pagamentoId/status", async (req,res)=>{
    try {
        const pagamentoId=texto(req.params.pagamentoId);
        if(!pagamentoId) return res.status(400).json({sucesso:false,erro:"Pagamento não informado."});

        const pagamentos=await firebaseGet(`pagamentos/${pagamentoId}`);
        const pedidoId=texto(pagamentos?.pedidoId);
        let token=MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : MP_ACCESS_TOKEN;

        if(pedidoId){
            const pedido=await firebaseGet(`pedidos/${pedidoId}`);
            if(pedido?.vendedorId){
                const vendedorMP=await firebaseGet(`vendedores/${pedido.vendedorId}/mercadoPago`);
                token=vendedorMP?.access_token || token;
            }
        }

        if(!token) return res.status(400).json({sucesso:false,erro:"Token Mercado Pago não disponível."});

        const resposta=await mercadoPagoRequest(
            `https://api.mercadopago.com/v1/payments/${encodeURIComponent(pagamentoId)}`,
            {headers:{Authorization:`Bearer ${token}`}}
        );
        if(!resposta.ok) return res.status(resposta.status).json({
            sucesso:false,erro:resposta.data?.message || resposta.data?.error || "Não foi possível consultar o pagamento."
        });

        const pagamento=resposta.data;
        res.json({
            sucesso:true,pagamentoId:String(pagamento.id),
            status:pagamento.status,statusDetail:pagamento.status_detail || null,
            aprovado:pagamento.status==="approved",pedidoId:pedidoId || null
        });
    } catch(erro) {
        console.error("ERRO STATUS PIX:",erro);
        res.status(500).json({sucesso:false,erro:erro.message});
    }
});

// ============================================================
// PROCESSAR PAGAMENTO APROVADO
// ============================================================

async function processarPagamentoAprovado(pagamentoId, accessTokenFallback = MP_ACCESS_TOKEN) {
    const token = accessTokenFallback;
    if (!token) throw new Error("Token Mercado Pago não disponível para consultar pagamento.");

    const resposta = await mercadoPagoRequest(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(pagamentoId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resposta.ok) throw new Error(`Pagamento ${pagamentoId}: HTTP ${resposta.status}`);

    const pagamento = resposta.data;
    if (pagamento.status !== "approved") {
        return { aprovado: false, status: pagamento.status };
    }

    // Idempotência por pagamento: se este pagamento já foi concluído,
    // nunca processa a compra novamente. A chave é exclusiva do pagamento.
    const chaveProcessamento = `processamentoPagamentos/${encodeURIComponent(String(pagamento.id))}`;
    const processamentoExistente = await firebaseGet(chaveProcessamento);
    if (processamentoExistente?.licencaId) {
        return { aprovado: true, repetido: true, licencaId: processamentoExistente.licencaId };
    }

    // A versão atual usa somente o ID curto do pedido em external_reference.
    // Também aceitamos referências antigas em Base64 JSON.
    const externalReference = texto(pagamento.external_reference);
    let meta = {};
    let pedidoId = externalReference;

    if (externalReference) {
        try {
            const antiga = JSON.parse(
                Buffer.from(externalReference, "base64url").toString("utf8")
            );
            if (antiga && typeof antiga === "object" && antiga.pedidoId) {
                meta = antiga;
                pedidoId = texto(antiga.pedidoId, externalReference);
            }
        } catch {
            // Referência atual: é simplesmente o ID do pedido.
        }
    }

    if (!pedidoId) throw new Error("Pedido não identificado no pagamento.");

    const pedido = await firebaseGet(`pedidos/${encodeURIComponent(pedidoId)}`);
    if (!pedido) throw new Error(`Pedido ${pedidoId} não encontrado no Firebase.`);

    // Idempotência do webhook.
    if (pedido.status === "pago" && pedido.licencaId) {
        return { aprovado: true, repetido: true, licencaId: pedido.licencaId };
    }

    const compra = {
        pedidoId,
        pagamentoId: String(pagamento.id),
        produtoId: texto(pedido.produtoId, texto(meta.produtoId)),
        vendedorId: texto(pedido.vendedorId, texto(meta.vendedorId)),
        compradorId: texto(pedido.compradorId, texto(meta.compradorId)),
        compradorEmail: texto(pedido.compradorEmail, texto(meta.compradorEmail)),
        id: texto(pedido.produtoId, texto(meta.produtoId)),
        titulo: texto(pedido.titulo, "Produto"),
        preco: Number(pagamento.transaction_amount || pedido.preco || 0)
    };

    await firebaseSet(`pagamentos/${pagamento.id}`, {
        id: pagamento.id,
        pedidoId,
        status: pagamento.status,
        statusDetail: pagamento.status_detail || null,
        transactionAmount: pagamento.transaction_amount || null,
        payerEmail: pagamento.payer?.email || compra.compradorEmail || null,
        aprovadoEm: Date.now(),
        atualizadoEm: Date.now()
    });

    await firebasePatch(`pedidos/${pedidoId}`, {
        status: "pago",
        pagamentoId: String(pagamento.id),
        aprovadoEm: Date.now(),
        atualizadoEm: Date.now()
    });

    const licenca = await criarLicencaParaCompra(compra);

    await firebasePatch(`pedidos/${pedidoId}`, {
        licencaId: licenca.id,
        licencaStatus: "ativa",
        licencaChave: licenca.chave,
        atualizadoEm: Date.now()
    });

    // Mantém o vínculo pagamento -> licença. O fluxo de reembolso usa
    // este registro como fonte de verdade para localizar e desativar
    // a licença mesmo quando o pedido antigo não possui licencaId.
    await firebasePatch(`pagamentos/${encodeURIComponent(String(pagamento.id))}`, {
        licencaId: licenca.id,
        licencaStatus: "ativa",
        atualizadoEm: Date.now()
    });

    // ------------------------------------------------------------
    // REGISTRAR A VENDA REAL DO VENDEDOR
    // ------------------------------------------------------------
    // Uma venda fica gravada por pagamento para que a Central do
    // Vendedor consiga mostrar o histórico completo, sem depender
    // apenas do contador "vendas" do produto.
    const calculoVenda = calcularTaxaMaketiplace(compra.preco);
    await firebaseSet(`vendas/${encodeURIComponent(String(pagamento.id))}`, {
        id: String(pagamento.id),
        pedidoId,
        pagamentoId: String(pagamento.id),
        produtoId: compra.produtoId,
        titulo: compra.titulo,
        vendedorId: compra.vendedorId,
        compradorId: compra.compradorId || null,
        compradorEmail: compra.compradorEmail || null,
        valorBruto: Number(compra.preco || 0),
        // Aliases mantidos para compatibilidade com Centrais antigas.
        valor: Number(compra.preco || 0),
        taxaPlataforma: Number(calculoVenda.taxa || 0),
        valorTaxa: Number(calculoVenda.taxa || 0),
        faturamento: Number(calculoVenda.vendedorRecebe || 0),
        valorLiquido: Number(calculoVenda.vendedorRecebe || 0),
        vendedorRecebe: Number(calculoVenda.vendedorRecebe || 0),
        status: "pago",
        criadoEm: Number(pedido.criadoEm || Date.now()),
        pagoEm: Date.now(),
        atualizadoEm: Date.now()
    });

    // Mantém também os números do produto atualizados.
    const produtoAtual = await firebaseGet(`produtos/${encodeURIComponent(compra.produtoId)}`);
    if (produtoAtual && typeof produtoAtual === "object") {
        const vendasProduto = (Number(produtoAtual.vendas) || 0) + 1;
        const faturamentoProduto =
            (Number(produtoAtual.faturamento) || 0) +
            Number(calculoVenda.vendedorRecebe || 0);
        await firebasePatch(`produtos/${encodeURIComponent(compra.produtoId)}`, {
            vendas: vendasProduto,
            faturamento: Number(faturamentoProduto.toFixed(2)),
            ultimaVendaEm: Date.now()
        });
    }

    // Atualiza imediatamente qualquer Central do Vendedor aberta.
    enviarAtualizacaoCentral(compra.vendedorId, "venda_aprovada");

    return {
        aprovado: true,
        repetido: Boolean(licenca.__repetido),
        licencaId: licenca.id
    };
}


// ============================================================
// REEMBOLSOS — JANELA DE 2 MINUTOS
// ============================================================

async function encontrarPedidoPagoDoCliente(clienteId, pedidoId, produtoId, emailCliente, pagamentoId) {
    if (!clienteId) return null;

    // Normaliza e-mails antes de qualquer caminho da função.
    // Importante: o caminho com pagamentoId é usado pela página de produto
    // logo após uma compra e precisa dessa função já inicializada.
    const textoLower = (v) => String(v ?? "").trim().toLowerCase();

    // Se a página de pagamento já possui o pagamento, use-o diretamente.
    // Isso evita depender de uma busca genérica no Firebase e resolve o caso
    // em que a compra foi aprovada, mas algum campo antigo do pedido não foi
    // gravado no formato esperado.
    if (pagamentoId) {
        const pagamentoDireto = await firebaseGet(`pagamentos/${encodeURIComponent(String(pagamentoId))}`);
        const statusPagamento = textoLower(pagamentoDireto?.status);
        if (!pagamentoDireto || statusPagamento !== "approved") return null;

        const pedidoIdDireto = texto(pagamentoDireto?.pedidoId, pedidoId);
        if (!pedidoIdDireto) return null;
        const pedidoDireto = await firebaseGet(`pedidos/${encodeURIComponent(pedidoIdDireto)}`);
        if (!pedidoDireto) return null;

        const emailAlvo = textoLower(emailCliente);
        const idsCliente = [
            pedidoDireto.compradorId, pedidoDireto.clienteId, pedidoDireto.usuarioId,
            pedidoDireto.userId, pedidoDireto.customerId
        ].filter(Boolean).map(String);
        const emailsCliente = [
            pedidoDireto.compradorEmail, pedidoDireto.clienteEmail, pedidoDireto.usuarioEmail,
            pedidoDireto.email
        ].filter(Boolean).map(textoLower);

        const pertence = idsCliente.includes(String(clienteId)) ||
            (emailAlvo && emailsCliente.includes(emailAlvo));

        if (!pertence) return null;

        // O pagamento é a fonte de verdade para o status da compra.
        // O pedido pode estar atrasado na atualização do webhook.
        if (String(pedidoDireto.status || '').toLowerCase() !== 'pago') {
            await firebasePatch(`pedidos/${encodeURIComponent(pedidoIdDireto)}`, {
                status: 'pago',
                pagamentoId: String(pagamentoId),
                aprovadoEm: Number(pagamentoDireto.aprovadoEm || Date.now()),
                atualizadoEm: Date.now()
            });
            pedidoDireto.status = 'pago';
            pedidoDireto.pagamentoId = String(pagamentoId);
            pedidoDireto.aprovadoEm = Number(pagamentoDireto.aprovadoEm || Date.now());
        }

        return { ...pedidoDireto, id: pedidoDireto.id || pedidoIdDireto };
    }

    const produtoPertence = (pedido) => {
        if (!produtoId) return true;
        const alvo = String(produtoId);
        const idsDiretos = [
            pedido?.produtoId, pedido?.idProduto, pedido?.productId,
            pedido?.appId, pedido?.aplicativoId, pedido?.produto?.id,
            pedido?.aplicativo?.id
        ].filter(v => v !== undefined && v !== null && v !== "").map(String);
        if (idsDiretos.includes(alvo)) return true;

        const colecoes = [pedido?.itens, pedido?.produtos, pedido?.items, pedido?.carrinho, pedido?.aplicativos];
        for (const colecao of colecoes) {
            if (!colecao) continue;
            const itens = Array.isArray(colecao) ? colecao : Object.values(colecao);
            for (const item of itens) {
                const idsItem = [
                    item?.produtoId, item?.idProduto, item?.productId, item?.appId,
                    item?.aplicativoId, item?.id, item?.produto?.id, item?.aplicativo?.id
                ].filter(v => v !== undefined && v !== null && v !== "").map(String);
                if (idsItem.includes(alvo)) return true;
            }
        }
        return false;
    };

    const statusPago = (pedido) => {
        const status = textoLower(pedido?.status || pedido?.statusPagamento || pedido?.paymentStatus);
        return ['pago','paid','aprovado','approved','concluido','completed','finalizado','finalizada','entregue','confirmado','confirmed'].includes(status);
    };

    const clientePertence = async (pedido) => {
        if (!pedido || !statusPago(pedido) || !pedido.pagamentoId) return false;
        if (!produtoPertence(pedido)) return false;

        const idsCliente = [
            pedido.compradorId, pedido.clienteId, pedido.usuarioId, pedido.userId, pedido.customerId,
            pedido.comprador?.id, pedido.cliente?.id, pedido.usuario?.id, pedido.user?.id
        ].filter(Boolean).map(String);
        const emailsCliente = [
            pedido.compradorEmail, pedido.clienteEmail, pedido.usuarioEmail, pedido.email,
            pedido.comprador?.email, pedido.cliente?.email, pedido.usuario?.email, pedido.user?.email
        ].filter(Boolean).map(textoLower);

        if (idsCliente.includes(String(clienteId))) return true;
        const emailAlvo = textoLower(emailCliente);
        if (emailAlvo && emailsCliente.includes(emailAlvo)) return true;

        // Algumas compras antigas não gravaram o e-mail/UID no pedido.
        // Nesse caso, confira o e-mail do pagador salvo em pagamentos/{paymentId}.
        try {
            const pagamento = await firebaseGet(`pagamentos/${encodeURIComponent(String(pedido.pagamentoId))}`);
            const emailPagamento = textoLower(pagamento?.payerEmail || pagamento?.email || pagamento?.payer?.email);
            if (emailAlvo && emailPagamento === emailAlvo) return true;
        } catch (e) {
            console.warn("Não foi possível consultar o pagamento do pedido:", e?.message || e);
        }

        return false;
    };

    if (pedidoId) {
        const pedido = await firebaseGet(`pedidos/${encodeURIComponent(pedidoId)}`);
        return (await clientePertence(pedido)) ? pedido : null;
    }

    const pedidos = await firebaseGet('pedidos') || {};
    const entradas = Object.entries(pedidos);
    for (const [chave, pedido] of entradas) {
        if (await clientePertence(pedido)) {
            return { ...(pedido || {}), id: pedido?.id || chave };
        }
    }
    return null;
}

async function obterInicioJanelaReembolso(pedido) {
    const pagamento = pedido?.pagamentoId
        ? await firebaseGet(`pagamentos/${encodeURIComponent(String(pedido.pagamentoId))}`)
        : null;

    const inicio = Number(
        pagamento?.aprovadoEm ||
        pedido?.aprovadoEm ||
        pagamento?.atualizadoEm ||
        pedido?.atualizadoEm ||
        pedido?.criadoEm ||
        0
    );

    return Number.isFinite(inicio) && inicio > 0 ? inicio : 0;
}

app.get("/api/reembolso/situacao", async (req, res) => {
    try {
        const usuario = await usuarioFirebaseDoToken(req);
        if (!usuario?.localId) {
            return res.status(401).json({ sucesso:false, erro:"Entre na sua conta." });
        }

        const pedidoIdInformado = texto(req.query.pedidoId);
        const pagamentoIdInformado = texto(req.query.pagamentoId);
        const produtoId = texto(req.query.produtoId);
        if (!produtoId) return res.status(400).json({ sucesso:false, erro:"produtoId é obrigatório." });

        const pedidoEncontrado = await encontrarPedidoPagoDoCliente(usuario.localId, pedidoIdInformado, produtoId, usuario.email, pagamentoIdInformado);
        if (!pedidoEncontrado) return res.status(404).json({ sucesso:false, erro:"Compra paga não encontrada." });

        const pedidoId = texto(pedidoEncontrado.id, pedidoIdInformado);
        const pedido = pedidoEncontrado;

        const inicio = await obterInicioJanelaReembolso(pedido);
        const agora = Date.now();
        const retencaoAte = inicio + REEMBOLSO_JANELA_MS;
        const restanteMs = Math.max(0, retencaoAte - agora);

        const existenteTodos = await firebaseGet("reembolsos") || {};
        const existente = Object.values(existenteTodos).find(r =>
            String(r?.clienteId || "") === String(usuario.localId) &&
            String(r?.pedidoId || "") === String(pedidoId) &&
            String(r?.produtoId || "") === String(produtoId || pedido.produtoId || "")
        );

        return res.json({
            sucesso:true,
            pedidoId: pedidoId || pedido.id || null,
            produtoId: produtoId || pedido.produtoId || null,
            pedido: pedido,

            podeSolicitar: !existente && restanteMs > 0 && !["reembolsado","refund_approved"].includes(String(pedido.status || "").toLowerCase()),
            restanteMs,
            retencaoAte,
            retencaoMinutos: REEMBOLSO_JANELA_MINUTOS,
            reembolso: existente || null
        });
    } catch (erro) {
        console.error("ERRO SITUAÇÃO REEMBOLSO:", erro);
        return res.status(500).json({ sucesso:false, erro:"Não foi possível verificar o reembolso." });
    }
});

app.post("/api/reembolsos", async (req, res) => {
    try {
        const usuario = await usuarioFirebaseDoToken(req);
        if (!usuario?.localId) {
            return res.status(401).json({ sucesso:false, erro:"Entre na sua conta." });
        }

        const pedidoId = texto(req.body?.pedidoId);
        const pagamentoId = texto(req.body?.pagamentoId);
        const produtoId = texto(req.body?.produtoId);
        const motivo = texto(req.body?.motivo);
        const detalhes = texto(req.body?.detalhes);

        if ((!pedidoId && !pagamentoId) || !produtoId || !motivo) {
            return res.status(400).json({ sucesso:false, erro:"Pedido ou pagamento, produto e motivo são obrigatórios." });
        }

        const pedido = await encontrarPedidoPagoDoCliente(usuario.localId, pedidoId, produtoId, usuario.email, pagamentoId);
        if (!pedido) {
            return res.status(404).json({ sucesso:false, codigo:"COMPRA_NAO_ENCONTRADA", erro:"Compra paga não encontrada." });
        }

        const inicio = await obterInicioJanelaReembolso(pedido);
        const agora = Date.now();
        const retencaoAte = inicio + REEMBOLSO_JANELA_MS;

        if (!inicio || agora >= retencaoAte) {
            return res.status(410).json({
                sucesso:false,
                codigo:"JANELA_REEMBOLSO_ENCERRADA",
                erro:`O prazo de reembolso de ${REEMBOLSO_JANELA_MINUTOS} minutos terminou.`,
                retencaoAte,
                restanteMs:0
            });
        }

        const todos = await firebaseGet("reembolsos") || {};
        const existente = Object.values(todos).find(r =>
            String(r?.clienteId || "") === String(usuario.localId) &&
            String(r?.pedidoId || "") === String(pedidoId) &&
            String(r?.produtoId || "") === String(produtoId)
        );
        if (existente) {
            return res.status(409).json({
                sucesso:false,
                codigo:"REEMBOLSO_EXISTENTE",
                erro:"Já existe uma solicitação de reembolso para esta compra.",
                reembolso:existente
            });
        }

        const pedidoIdFinal = texto(pedido.id || pedidoId);
        const pagamentoIdFinal = texto(pedido.pagamentoId || pagamentoId);
        const clienteNomeFinal = texto(
            usuario.displayName ||
            pedido.compradorNome || pedido.clienteNome || pedido.usuarioNome || pedido.nomeCliente ||
            ""
        );
        const clienteEmailFinal = texto(
            usuario.email ||
            pedido.compradorEmail || pedido.clienteEmail || pedido.usuarioEmail || pedido.email ||
            ""
        ).toLowerCase();
        const produtoNomeFinal = texto(
            pedido.produtoNome || pedido.titulo || pedido.nomeProduto || pedido.produto?.nome ||
            "Produto"
        );
        const valorFinal = Number(Number(
            pedido.preco ?? pedido.valor ?? pedido.valorTotal ?? pedido.total ?? pedido.produto?.preco ?? 0
        ).toFixed(2));

        const reembolsoId = crypto.randomUUID();
        const dados = {
            id: reembolsoId,
            clienteId: usuario.localId,
            clienteNome: clienteNomeFinal,
            clienteEmail: clienteEmailFinal,
            compradorId: usuario.localId,
            compradorNome: clienteNomeFinal,
            compradorEmail: clienteEmailFinal,
            pedidoId: pedidoIdFinal,
            produtoId,
            produtoNome: produtoNomeFinal,
            titulo: produtoNomeFinal,
            vendedorId: texto(pedido.vendedorId || pedido.sellerId),
            pagamentoId: pagamentoIdFinal,
            valor: valorFinal,
            preco: valorFinal,
            motivo,
            detalhes,
            status:"pendente",
            criadoEm: agora,
            solicitadoEm: agora,
            atualizadoEm: agora,
            retencaoAte
        };

        await firebaseSet(`reembolsos/${encodeURIComponent(reembolsoId)}`, dados);
        await firebasePatch(`pedidos/${encodeURIComponent(pedidoIdFinal)}`, {
            reembolsoStatus:"pendente",
            reembolsoId,
            reembolsoSolicitadoEm: agora,
            reembolsoRetencaoAte: retencaoAte,
            atualizadoEm: agora
        });

        return res.status(201).json({
            sucesso:true,
            reembolso:dados,
            retencaoMinutos:REEMBOLSO_JANELA_MINUTOS,
            restanteMs:Math.max(0, retencaoAte - agora)
        });
    } catch (erro) {
        console.error("ERRO SOLICITANDO REEMBOLSO:", erro);
        return res.status(500).json({ sucesso:false, erro:"Erro interno ao solicitar reembolso." });
    }
});

app.get("/api/admin/reembolsos", async (req, res) => {
    try {
        if (!(await validarAdminToken(req))) {
            return res.status(403).json({ sucesso:false, erro:"Acesso administrativo não autorizado." });
        }

        const todos = await firebaseGet("reembolsos") || {};
        const agora = Date.now();

        // Carrega as imagens dos aplicativos uma única vez para que a
        // Central do Administrador consiga mostrar a foto do produto
        // junto de cada solicitação de reembolso.
        const produtosDb = await firebaseGet("produtos") || {};
        const aplicativosDb = await firebaseGet("aplicativos") || {};
        const produtoPorId = { ...aplicativosDb, ...produtosDb };

        const obterImagemProduto = (produto) => {
            if (!produto || typeof produto !== "object") return "";
            const candidatos = [
                produto.imagem,
                produto.imagemUrl,
                produto.foto,
                produto.fotoUrl,
                produto.logo,
                produto.image,
                produto.imageUrl
            ];
            for (const valor of candidatos) {
                if (typeof valor === "string" && valor.trim()) return valor.trim();
                if (valor && typeof valor === "object") {
                    const url = valor.url || valor.downloadURL || valor.downloadUrl || valor.src || valor.dataUrl || valor.dataURL;
                    if (typeof url === "string" && url.trim()) return url.trim();
                }
            }
            return "";
        };

        const lista = Object.values(todos)
            .filter(r => String(r?.status || "pendente").toLowerCase() === "pendente")
            .map(r => {
                const produtoId = texto(r?.produtoId || r?.aplicativoId || r?.appId);
                const produto = produtoId ? produtoPorId[produtoId] : null;
                return {
                    ...r,
                    produtoId,
                    produtoNome: texto(r?.produtoNome || r?.titulo || r?.nomeProduto || produto?.nome || produto?.nomeApp, "Produto"),
                    produtoImagem: obterImagemProduto(produto),
                    clienteNome: texto(r?.clienteNome || r?.compradorNome),
                    clienteEmail: texto(r?.clienteEmail || r?.compradorEmail),
                    compradorId: texto(r?.compradorId || r?.clienteId),
                    compradorEmail: texto(r?.compradorEmail || r?.clienteEmail),
                    valor: Number(r?.valor ?? r?.preco ?? r?.valorBruto ?? 0),
                    preco: Number(r?.preco ?? r?.valor ?? r?.valorBruto ?? 0),
                    criadoEm: Number(r?.criadoEm || r?.solicitadoEm || r?.data || 0),
                    solicitadoEm: Number(r?.solicitadoEm || r?.criadoEm || r?.data || 0),
                    retencaoMinutos: REEMBOLSO_JANELA_MINUTOS,
                    restanteMs: Math.max(0, Number(r?.retencaoAte || 0) - agora)
                };
            })
            .sort((a,b) => Number(b.criadoEm || 0) - Number(a.criadoEm || 0));

        res.json({ sucesso:true, lista, retencaoMinutos:REEMBOLSO_JANELA_MINUTOS });
    } catch (erro) {
        console.error("ERRO LISTANDO REEMBOLSOS:", erro);
        res.status(500).json({ sucesso:false, erro:"Não foi possível carregar os reembolsos." });
    }
});

app.post("/api/admin/reembolsos/:pedidoId/decidir", async (req, res) => {
    try {
        if (!(await validarAdminToken(req))) {
            return res.status(403).json({ sucesso:false, erro:"Acesso administrativo não autorizado." });
        }

        const pedidoId = texto(req.params.pedidoId);
        const decisao = texto(req.body?.decisao).toLowerCase();
        const motivoAdmin = texto(req.body?.motivo);

        if (!pedidoId || !["aprovar","negar"].includes(decisao)) {
            return res.status(400).json({ sucesso:false, erro:"Decisão de reembolso inválida." });
        }

        const todos = await firebaseGet("reembolsos") || {};
        const entrada = Object.values(todos).find(r =>
            String(r?.pedidoId || "") === String(pedidoId) &&
            String(r?.status || "pendente").toLowerCase() === "pendente"
        );
        if (!entrada) return res.status(404).json({ sucesso:false, erro:"Solicitação de reembolso não encontrada." });

        const pedido = await firebaseGet(`pedidos/${encodeURIComponent(pedidoId)}`);
        if (!pedido) return res.status(404).json({ sucesso:false, erro:"Pedido não encontrado." });

        const agora = Date.now();

async function enviarEmailReembolso({
    email,
    nome = "Cliente",
    produto = "Produto",
    valor = 0,
    pagamentoId = "",
    pedidoId = "",
    reembolsoId = "",
    aprovado = true,
    motivo = ""
}) {
    if (!smtpConfigurado) return { enviado:false, erro:"SMTP não configurado." };
    const destinatario = texto(email).toLowerCase();
    if (!destinatario) return { enviado:false, erro:"E-mail do comprador não encontrado." };

    const valorFormatado = Number(valor || 0).toLocaleString("pt-BR", { style:"currency", currency:"BRL" });
    const dataFormatada = new Date().toLocaleString("pt-BR", { dateStyle:"short", timeStyle:"medium" });
    const nomeSeguro = escapeHtml(nome || "Cliente");
    const produtoSeguro = escapeHtml(produto || "Produto");
    const pagamentoSeguro = escapeHtml(pagamentoId || "-");
    const pedidoSeguro = escapeHtml(pedidoId || "-");
    const reembolsoSeguro = escapeHtml(reembolsoId || "-");
    const motivoSeguro = escapeHtml(motivo || "Solicitação analisada pelo administrador.");

    const assunto = aprovado
        ? "Reembolso aprovado — sua compra foi reembolsada"
        : "Reembolso recusado — atualização da sua solicitação";

    const textoEmail = aprovado
        ? [
            `Olá, ${nome || "Cliente"}!`,
            "",
            "Seu pedido de reembolso foi APROVADO pelo administrador.",
            "O estorno foi processado pelo Mercado Pago.",
            `Produto: ${produto || "Produto"}`,
            `Valor do reembolso: ${valorFormatado}`,
            `Pagamento: ${pagamentoId || "-"}`,
            `Pedido: ${pedidoId || "-"}`,
            `Reembolso: ${reembolsoId || "-"}`,
            `Data: ${dataFormatada}`,
            "",
            "A licença associada à compra foi marcada como reembolsada.",
            "Guarde este e-mail como comprovante do processamento do reembolso.",
            "",
            "Equipe da Loja"
        ].join("\n")
        : [
            `Olá, ${nome || "Cliente"}!`,
            "",
            "Seu pedido de reembolso foi RECUSADO pelo administrador.",
            `Motivo informado: ${motivo || "Solicitação recusada pelo administrador."}`,
            `Produto: ${produto || "Produto"}`,
            `Valor da compra: ${valorFormatado}`,
            `Pagamento: ${pagamentoId || "-"}`,
            `Pedido: ${pedidoId || "-"}`,
            `Solicitação de reembolso: ${reembolsoId || "-"}`,
            `Data: ${dataFormatada}`,
            "",
            "A compra permanece válida.",
            "",
            "Equipe da Loja"
        ].join("\n");

    const html = aprovado
        ? `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;padding:30px;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:650px;margin:auto;background:#fff;border-radius:18px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,.08)"><h1 style="margin-top:0;color:#16a34a">✅ Reembolso aprovado</h1><p>Olá, <strong>${nomeSeguro}</strong>!</p><p>Seu pedido de reembolso foi <strong>aprovado pelo administrador</strong> e o estorno foi processado pelo Mercado Pago.</p><div style="background:#f8fafc;border-radius:12px;padding:18px;margin:20px 0"><p><strong>Produto:</strong> ${produtoSeguro}</p><p><strong>Valor do reembolso:</strong> ${valorFormatado}</p><p><strong>Pagamento:</strong> ${pagamentoSeguro}</p><p><strong>Pedido:</strong> ${pedidoSeguro}</p><p><strong>ID do reembolso:</strong> ${reembolsoSeguro}</p><p><strong>Data:</strong> ${escapeHtml(dataFormatada)}</p></div><p>A licença associada a esta compra foi marcada como <strong>reembolsada</strong>.</p><p style="font-size:13px;color:#64748b">Guarde este e-mail como comprovante do processamento do reembolso.</p><p>Equipe da Loja</p></div></body></html>`
        : `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;padding:30px;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:650px;margin:auto;background:#fff;border-radius:18px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,.08)"><h1 style="margin-top:0;color:#dc2626">❌ Reembolso recusado</h1><p>Olá, <strong>${nomeSeguro}</strong>.</p><p>Seu pedido de reembolso foi <strong>recusado pelo administrador</strong>.</p><div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:18px;margin:20px 0"><p><strong>Motivo:</strong> ${motivoSeguro}</p><p><strong>Produto:</strong> ${produtoSeguro}</p><p><strong>Valor da compra:</strong> ${valorFormatado}</p><p><strong>Pedido:</strong> ${pedidoSeguro}</p><p><strong>Solicitação:</strong> ${reembolsoSeguro}</p><p><strong>Data:</strong> ${escapeHtml(dataFormatada)}</p></div><p>A compra permanece válida e não houve estorno do pagamento.</p><p>Equipe da Loja</p></div></body></html>`;

    await emailTransporter.sendMail({
        from: EMAIL_FROM,
        to: destinatario,
        subject: assunto,
        text: textoEmail,
        html
    });

    return { enviado:true, erro:"" };
}

        // ============================================================
        // REEMBOLSO RECUSADO
        // Não chama o Mercado Pago e não estorna o pagamento.
        // Apenas registra a decisão e envia o e-mail ao cliente.
        // ============================================================
        if (decisao === "negar") {
            const pagamentoIdRecusa = texto(entrada.pagamentoId || pedido.pagamentoId);
            const pagamentoRegistroRecusa = pagamentoIdRecusa
                ? await firebaseGet(`pagamentos/${encodeURIComponent(String(pagamentoIdRecusa))}`)
                : null;

            const emailClienteRecusa = texto(
                entrada.compradorEmail || entrada.clienteEmail ||
                pedido.compradorEmail || pedido.clienteEmail || pedido.usuarioEmail || pedido.email ||
                pagamentoRegistroRecusa?.payerEmail || pagamentoRegistroRecusa?.email || pagamentoRegistroRecusa?.payer?.email
            ).toLowerCase();
            const nomeClienteRecusa = texto(
                entrada.compradorNome || entrada.clienteNome ||
                pedido.compradorNome || pedido.clienteNome || pedido.usuarioNome ||
                "Cliente"
            );
            const produtoClienteRecusa = texto(
                entrada.produtoNome || entrada.produto ||
                pedido.produtoNome || pedido.titulo || pedido.nomeProduto || pedido.produto?.nome ||
                "Produto"
            );
            const valorClienteRecusa = Number(
                entrada.preco ?? entrada.valor ?? pedido.preco ?? pedido.valor ?? pedido.valorTotal ?? pedido.total ??
                pagamentoRegistroRecusa?.transactionAmount ?? pagamentoRegistroRecusa?.valor ?? 0
            );

            const atualizadoRecusa = {
                ...entrada,
                status: "negado",
                motivoAdmin: motivoAdmin || "Solicitação de reembolso recusada pelo administrador.",
                decididoEm: agora,
                decididoPor: ADMIN_EMAIL,
                atualizadoEm: agora
            };
            await firebaseSet(`reembolsos/${encodeURIComponent(String(entrada.id))}`, atualizadoRecusa);

            await firebasePatch(`pedidos/${encodeURIComponent(pedidoId)}`, {
                reembolsoStatus: "negado",
                reembolsoDecididoEm: agora,
                reembolsoMotivoAdmin: motivoAdmin || "Solicitação de reembolso recusada pelo administrador.",
                atualizadoEm: agora
            });

            let emailReembolsoRecusa = { enviado:false, erro:"E-mail automático não configurado." };
            try {
                emailReembolsoRecusa = await enviarEmailReembolso({
                    email: emailClienteRecusa,
                    nome: nomeClienteRecusa,
                    produto: produtoClienteRecusa,
                    valor: valorClienteRecusa,
                    pagamentoId: String(pagamentoIdRecusa || ""),
                    pedidoId: String(pedidoId),
                    reembolsoId: String(entrada.id),
                    aprovado: false,
                    motivo: motivoAdmin || "Solicitação de reembolso recusada pelo administrador."
                });
            } catch (erroEmailRecusa) {
                console.error("ERRO AO ENVIAR E-MAIL DE REEMBOLSO RECUSADO:", erroEmailRecusa);
                emailReembolsoRecusa = {
                    enviado:false,
                    erro:erroEmailRecusa.message || "Erro ao enviar e-mail de reembolso recusado."
                };
            }

            await firebasePatch(`reembolsos/${encodeURIComponent(String(entrada.id))}`, {
                emailReembolsoEnviado: Boolean(emailReembolsoRecusa.enviado),
                emailReembolsoErro: emailReembolsoRecusa.erro || null,
                emailReembolsoEnviadoEm: emailReembolsoRecusa.enviado ? agora : null,
                atualizadoEm: Date.now()
            });

            return res.json({
                sucesso:true,
                status:"negado",
                pagamentoId: pagamentoIdRecusa || null,
                emailReembolsoEnviado:Boolean(emailReembolsoRecusa.enviado),
                emailReembolsoErro:emailReembolsoRecusa.erro || null
            });
        }

        const pagamentoId = texto(entrada.pagamentoId || pedido.pagamentoId);
        if (!pagamentoId) return res.status(400).json({ sucesso:false, erro:"Pagamento do pedido não encontrado." });

        const vendedorId = texto(pedido.vendedorId || entrada.vendedorId);
        const vendedorMP = vendedorId ? await firebaseGet(`vendedores/${encodeURIComponent(vendedorId)}/mercadoPago`) : null;
        const token = MP_TEST_MODE ? MP_TEST_ACCESS_TOKEN : texto(vendedorMP?.access_token || MP_ACCESS_TOKEN);
        if (!token) return res.status(503).json({ sucesso:false, erro:"Token do Mercado Pago não disponível para estorno." });

        const resposta = await mercadoPagoRequest(
            `https://api.mercadopago.com/v1/payments/${encodeURIComponent(pagamentoId)}/refunds`,
            {
                method:"POST",
                headers:{
                    Authorization:`Bearer ${token}`,
                    "Content-Type":"application/json",
                    "X-Idempotency-Key":`refund-${pagamentoId}`
                },
                body:"{}"
            }
        );

        if (!resposta.ok) {
            console.error("ERRO ESTORNO MERCADO PAGO:", resposta.data);
            return res.status(resposta.status).json({
                sucesso:false,
                erro:resposta.data?.message || resposta.data?.error || "Mercado Pago não aceitou o estorno.",
                detalhe:resposta.data || null
            });
        }

        const pagamentoAntesDoEstorno = await firebaseGet(`pagamentos/${encodeURIComponent(String(pagamentoId))}`);
        const licencaIdAntesDoEstorno = texto(pedido.licencaId || pagamentoAntesDoEstorno?.licencaId || entrada.licencaId);

        const atualizado = {
            ...entrada,
            licencaId: licencaIdAntesDoEstorno || null,
            status:"aprovado",
            motivoAdmin:motivoAdmin || "Reembolso aprovado pelo administrador.",
            decididoEm:agora,
            decididoPor:ADMIN_EMAIL,
            processadoEm:agora,
            atualizadoEm:agora,
            mercadoPago:resposta.data || null
        };
        await firebaseSet(`reembolsos/${encodeURIComponent(String(entrada.id))}`, atualizado);

        await firebasePatch(`pedidos/${encodeURIComponent(pedidoId)}`, {
            status:"reembolsado",
            reembolsoStatus:"aprovado",
            reembolsadoEm:agora,
            reembolsoDecididoEm:agora,
            atualizadoEm:agora
        });

        if (pedido.pagamentoId) {
            const venda = await firebaseGet(`vendas/${encodeURIComponent(String(pedido.pagamentoId))}`);
            if (venda) {
                await firebasePatch(`vendas/${encodeURIComponent(String(pedido.pagamentoId))}`, {
                    status:"reembolsado",
                    reembolsadoEm:agora,
                    atualizadoEm:agora
                });
            }
        }

        // O licencaId pode estar no pedido ou diretamente no registro do pagamento.
        // Usamos os dois caminhos para corrigir compras antigas e novas.
        const pagamentoRegistro = await firebaseGet(`pagamentos/${encodeURIComponent(String(pagamentoId))}`);
        const licencaId = texto(
            pedido.licencaId ||
            pagamentoRegistro?.licencaId ||
            entrada.licencaId
        );

        if (licencaId) {
            const dadosLicencaReembolso = {
                status:"reembolsada",
                licencaStatus:"reembolsada",
                reembolsadaEm:agora,
                reembolsoId:String(entrada.id),
                pagamentoId:String(pagamentoId),
                pedidoId:String(pedidoId),
                atualizadoEm:agora
            };

            // Atualiza o registro principal da licença.
            const caminhoLicenca = `licencas/${encodeURIComponent(String(licencaId))}`;
            await firebasePatch(caminhoLicenca, dadosLicencaReembolso);

            // Algumas compras também possuem uma cópia da licença dentro do comprador.
            // Essa cópia precisa ser encerrada junto com a licença principal, senão
            // a central do comprador pode continuar mostrando a licença como ativa.
            const compradorId = texto(
                pedido.compradorId ||
                pedido.clienteId ||
                pagamentoRegistro?.compradorId ||
                pagamentoRegistro?.clienteId ||
                entrada.compradorId ||
                entrada.clienteId
            );

            if (compradorId) {
                await firebasePatch(
                    `compradores/${encodeURIComponent(compradorId)}/licencas/${encodeURIComponent(String(licencaId))}`,
                    {
                        status:"reembolsada",
                        licencaStatus:"reembolsada",
                        reembolsadaEm:agora,
                        reembolsoId:String(entrada.id),
                        pagamentoId:String(pagamentoId),
                        pedidoId:String(pedidoId),
                        atualizadoEm:agora
                    }
                );
            }

            // Mantém a compra sincronizada com a licença.
            await firebasePatch(`compras/${encodeURIComponent(String(pedidoId))}`, {
                licencaStatus:"reembolsada",
                reembolsoStatus:"aprovado",
                reembolsadaEm:agora,
                reembolsoId:String(entrada.id),
                atualizadoEm:agora
            });

            // Confirma que o registro principal realmente foi alterado.
            // Isso evita devolver sucesso ao administrador se o banco não aceitar a atualização.
            const licencaDepois = await firebaseGet(caminhoLicenca);
            if (String(licencaDepois?.status || "").toLowerCase() !== "reembolsada") {
                throw new Error("O estorno foi confirmado pelo Mercado Pago, mas a licença não pôde ser atualizada no Firebase.");
            }
        }

        // Não apagamos o pagamento original nem trocamos seu status aprovado:
        // registramos separadamente que houve estorno confirmado.
        await firebasePatch(`pagamentos/${encodeURIComponent(String(pagamentoId))}`, {
            reembolsoStatus:"reembolsado",
            reembolsoId:String(entrada.id),
            reembolsadoEm:agora,
            licencaId:licencaId || pagamentoRegistro?.licencaId || null,
            licencaStatus:licencaId ? "reembolsada" : (pagamentoRegistro?.licencaStatus || null),
            atualizadoEm:agora
        });

        // AVISO AO CLIENTE: depois que o Mercado Pago aceita o reembolso,
        // envia um e-mail para o comprador informando que o reembolso foi devolvido/processado.
        const emailCliente = texto(
            entrada.compradorEmail || entrada.clienteEmail ||
            pedido.compradorEmail || pedido.clienteEmail || pedido.usuarioEmail || pedido.email ||
            pagamentoRegistro?.payerEmail || pagamentoRegistro?.email || pagamentoRegistro?.payer?.email
        ).toLowerCase();
        const nomeCliente = texto(
            entrada.compradorNome || entrada.clienteNome ||
            pedido.compradorNome || pedido.clienteNome || pedido.usuarioNome ||
            "Cliente"
        );
        const produtoCliente = texto(
            entrada.produtoNome || entrada.produto ||
            pedido.produtoNome || pedido.titulo || pedido.nomeProduto || pedido.produto?.nome ||
            "Produto"
        );
        const valorCliente = Number(
            entrada.preco ?? entrada.valor ?? pedido.preco ?? pedido.valor ?? pedido.valorTotal ?? pedido.total ??
            pagamentoRegistro?.transactionAmount ?? pagamentoRegistro?.valor ?? 0
        );

        let emailReembolso = { enviado:false, erro:"E-mail automático não configurado." };
        try {
            emailReembolso = await enviarEmailReembolso({
                email: emailCliente,
                nome: nomeCliente,
                produto: produtoCliente,
                valor: valorCliente,
                pagamentoId: String(pagamentoId),
                pedidoId: String(pedidoId),
                reembolsoId: String(entrada.id),
                aprovado: true,
                motivo: motivoAdmin || "Reembolso aprovado pelo administrador."
            });
        } catch (erroEmail) {
            console.error("ERRO AO ENVIAR E-MAIL DE REEMBOLSO:", erroEmail);
            emailReembolso = { enviado:false, erro:erroEmail.message || "Erro ao enviar e-mail de reembolso." };
        }

        await firebasePatch(`reembolsos/${encodeURIComponent(String(entrada.id))}`, {
            emailReembolsoEnviado: Boolean(emailReembolso.enviado),
            emailReembolsoErro: emailReembolso.erro || null,
            emailReembolsoEnviadoEm: emailReembolso.enviado ? agora : null,
            atualizadoEm: Date.now()
        });

        return res.json({
            sucesso:true,
            status:"aprovado",
            pagamentoId,
            licencaId:licencaId || null,
            emailReembolsoEnviado:Boolean(emailReembolso.enviado),
            emailReembolsoErro:emailReembolso.erro || null
        });
    } catch (erro) {
        console.error("ERRO DECIDINDO REEMBOLSO:", erro);
        return res.status(500).json({ sucesso:false, erro:"Erro interno ao processar o reembolso." });
    }
});

// ============================================================
// WEBHOOK MERCADO PAGO
// ============================================================

app.post(["/mercadopago/webhook", "/webhook/mercadopago"], async (req, res) => {
    // Responde imediatamente ao Mercado Pago.
    res.status(200).json({ recebido: true });

    try {
        const tipo = texto(req.body?.type || req.body?.topic || req.query?.type || req.query?.topic);
        const pagamentoId = texto(
            req.body?.data?.id ||
            req.body?.id ||
            req.query?.["data.id"] ||
            req.query?.id
        );

        console.log("WEBHOOK Mercado Pago:", { tipo, pagamentoId });

        if (!pagamentoId) {
            console.warn("Webhook recebido sem pagamentoId.");
            return;
        }
        if (tipo && tipo !== "payment") return;

        let processado = false;

        if (MP_ACCESS_TOKEN) {
            try {
                const resultado = await processarPagamentoAprovado(pagamentoId, MP_ACCESS_TOKEN);
                console.log("Webhook processado com token da plataforma:", resultado);
                processado = true;
            } catch (erroPlataforma) {
                console.warn("Webhook: token da plataforma não localizou o pagamento:", erroPlataforma.message);
            }
        }

        if (!processado) {
            const vendedores = await firebaseGet("vendedores") || {};
            const tokensTentados = new Set();
            let ultimoErro = null;

            for (const [vendedorId, vendedor] of Object.entries(vendedores)) {
                const tokenVendedor = texto(vendedor?.mercadoPago?.access_token);
                if (!tokenVendedor || tokensTentados.has(tokenVendedor)) continue;
                tokensTentados.add(tokenVendedor);

                try {
                    const resultado = await processarPagamentoAprovado(pagamentoId, tokenVendedor);
                    console.log(`Webhook processado com token do vendedor ${vendedorId}:`, resultado);
                    processado = true;
                    break;
                } catch (erroVendedor) {
                    ultimoErro = erroVendedor;
                    console.warn(`Webhook: token do vendedor ${vendedorId} não localizou o pagamento:`, erroVendedor.message);
                }
            }

            if (!processado) {
                console.error(
                    "Webhook recebido, mas não foi possível identificar um token válido.",
                    ultimoErro?.message || "Nenhum token conectado disponível."
                );
            }
        }
    } catch (erro) {
        console.error("ERRO PROCESSANDO WEBHOOK:", erro);
    }
});

// ============================================================
// CENTRAL — STREAM EM TEMPO REAL
// ============================================================
app.get("/api/vendedor/:vendedorId/stream", async (req, res) => {
    const vendedorId = texto(req.params.vendedorId);
    if (!vendedorId) return res.status(400).end();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    if (!clientesCentralTempoReal.has(vendedorId)) {
        clientesCentralTempoReal.set(vendedorId, new Set());
    }
    const clientes = clientesCentralTempoReal.get(vendedorId);
    clientes.add(res);

    res.write(`event: conectado\ndata: ${JSON.stringify({ tipo: "conectado", vendedorId, agora: Date.now() })}\n\n`);

    const heartbeat = setInterval(() => {
        try {
            res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
            clearInterval(heartbeat);
            clientes.delete(res);
        }
    }, 20000);

    req.on("close", () => {
        clearInterval(heartbeat);
        clientes.delete(res);
        if (!clientes.size) clientesCentralTempoReal.delete(vendedorId);
    });
});

// ============================================================
// VENDAS — HISTÓRICO COMPLETO DO VENDEDOR
// ============================================================
app.get("/api/vendedor/:vendedorId/vendas", async (req, res) => {
    try {
        const vendedorId = texto(req.params.vendedorId);
        if (!vendedorId) {
            return res.status(400).json({ sucesso:false, erro:"Vendedor não informado." });
        }

        // Primeiro lê as vendas já registradas pelo webhook.
        const vendas = await firebaseGet("vendas");
        const pedidos = await firebaseGet("pedidos");
        const produtos = await firebaseGet("produtos");
        const lista = [];
        const pagamentosJaListados = new Set();

        for (const [id, venda] of Object.entries(vendas || {})) {
            if (!venda || texto(venda.vendedorId) !== vendedorId) continue;
            if (!["pago", "approved"].includes(texto(venda.status).toLowerCase())) continue;

            const pedido = pedidos?.[venda.pedidoId] || {};
            const produto = produtos?.[venda.produtoId] || {};
            const pagamentoId = texto(venda.pagamentoId || id);
            pagamentosJaListados.add(pagamentoId);

            lista.push({
                id: String(venda.id || id),
                pedidoId: texto(venda.pedidoId),
                pagamentoId,
                produtoId: texto(venda.produtoId),
                aplicativo: texto(venda.titulo || produto.nome || produto.nomeApp, "Aplicativo"),
                vendas: 1,
                faturamento: Number(venda.faturamento ?? venda.valorLiquido ?? pedido.vendedorRecebe ?? pedido.faturamento ?? 0),
                valorBruto: Number(venda.valorBruto ?? pedido.preco ?? 0),
                taxaPlataforma: Number(venda.taxaPlataforma ?? pedido.taxaPlataforma ?? Math.max(0, Number(venda.valorBruto ?? pedido.preco ?? 0) - Number(venda.faturamento ?? venda.valorLiquido ?? pedido.vendedorRecebe ?? pedido.faturamento ?? 0))),
                taxaPercentual: Number(venda.taxaPercentual ?? pedido.taxaPercentual ?? 0),
                status: "Pago",
                compradorEmail: texto(venda.compradorEmail || pedido.compradorEmail),
                data: Number(venda.pagoEm || venda.atualizadoEm || pedido.aprovadoEm || pedido.criadoEm || 0)
            });
        }

        // IMPORTANTE: também consulta pedidos pagos/aprovados.
        // Assim vendas antigas que foram aprovadas antes do registro em /vendas
        // continuam aparecendo na Central do Vendedor.
        for (const [pedidoId, pedido] of Object.entries(pedidos || {})) {
            if (!pedido || texto(pedido.vendedorId) !== vendedorId) continue;
            const status = texto(pedido.status).toLowerCase();
            const aprovado = status === "pago" || status === "approved" || Boolean(pedido.aprovado);
            if (!aprovado) continue;

            const pagamentoId = texto(pedido.pagamentoId);
            if (pagamentoId && pagamentosJaListados.has(pagamentoId)) continue;

            const produtoId = texto(pedido.produtoId);
            const produto = produtos?.[produtoId] || {};
            const valorBruto = Number(pedido.preco || pedido.valor || produto.preco || 0);
            const valorVendedor = Number(
                pedido.vendedorRecebe ??
                pedido.faturamento ??
                pedido.valorLiquido ??
                valorBruto
            );

            lista.push({
                id: pagamentoId || String(pedidoId),
                pedidoId: String(pedidoId),
                pagamentoId,
                produtoId,
                aplicativo: texto(pedido.titulo || pedido.produto || produto.nome || produto.nomeApp, "Aplicativo"),
                vendas: 1,
                faturamento: Number(valorVendedor.toFixed(2)),
                valorBruto: Number(valorBruto.toFixed(2)),
                taxaPlataforma: Number((pedido.taxaPlataforma ?? Math.max(0, valorBruto - valorVendedor)).toFixed(2)),
                taxaPercentual: Number((pedido.taxaPercentual ?? (valorBruto > 0 ? (((pedido.taxaPlataforma ?? Math.max(0, valorBruto - valorVendedor)) / valorBruto) * 100) : 0)).toFixed(2)),
                status: "Pago",
                compradorEmail: texto(pedido.compradorEmail),
                data: Number(pedido.aprovadoEm || pedido.pagoEm || pedido.atualizadoEm || pedido.criadoEm || 0)
            });
        }

        lista.sort((a,b) => b.data - a.data);
        const totalVendas = lista.reduce((s, v) => s + (Number(v.vendas) || 1), 0);
        const faturamento = Number(lista.reduce((s, v) => s + (Number(v.faturamento) || 0), 0).toFixed(2));
        const faturamentoBruto = Number(lista.reduce((s, v) => s + (Number(v.valorBruto) || 0), 0).toFixed(2));
        const taxaTotal = Number(lista.reduce((s, v) => s + (Number(v.taxaPlataforma) || 0), 0).toFixed(2));

        return res.json({ sucesso:true, vendedorId, totalVendas, faturamento, faturamentoBruto, taxaTotal, vendas:lista });
    } catch (erro) {
        console.error("ERRO HISTÓRICO DE VENDAS:", erro);
        return res.status(500).json({ sucesso:false, erro:erro.message });
    }
});

// ============================================================
// LICENÇA — CONSULTAR POR PEDIDO
// ============================================================

app.get("/api/licenca/pedido/:pedidoId", async (req, res) => {
    try {
        const pedidoId = texto(req.params.pedidoId);
        const pedido = await firebaseGet(`pedidos/${pedidoId}`);

        if (!pedido) return res.status(404).json({ sucesso: false, erro: "Pedido não encontrado." });
        if (!pedido.licencaId) return res.status(409).json({ sucesso: false, pronta: false, erro: "Licença ainda não liberada." });

        const licenca = await firebaseGet(`licencas/${pedido.licencaId}`);
        if (!licenca) return res.status(404).json({ sucesso: false, erro: "Licença não encontrada." });

        res.json({
            sucesso: true,
            pronta: true,
            licenca: {
                id: licenca.id,
                chave: licenca.chave,
                produtoId: licenca.produtoId,
                status: licenca.status,
                tipo: licenca.tipo,
                criadaEm: licenca.criadaEm
            }
        });
    } catch (erro) {
        console.error("ERRO CONSULTANDO LICENÇA:", erro);
        res.status(500).json({ sucesso: false, erro: erro.message });
    }
});

// ============================================================
// LICENÇA — VALIDAR CHAVE
// ============================================================
// O APK pode chamar este endpoint para validar sua licença.
// Não confie somente no frontend: a regra precisa ser aplicada no APK.
// ============================================================

app.post("/api/licenca/validar", async (req, res) => {
    try {
        const chave = texto(req.body.chave);
        const produtoId = texto(req.body.produtoId);
        const dispositivoId = texto(req.body.dispositivoId);

        if (!chave) return res.status(400).json({ valida: false, erro: "Chave não informada." });

        const hash = hashLicenca(chave);
        const licencas = await firebaseGet("licencas");

        let encontrada = null;
        if (licencas && typeof licencas === "object") {
            for (const item of Object.values(licencas)) {
                if (item?.chaveHash === hash) {
                    encontrada = item;
                    break;
                }
            }
        }

        if (!encontrada) return res.status(404).json({ valida: false, erro: "Licença inválida." });
        if (encontrada.status !== "ativa") {
            return res.status(403).json({ valida: false, erro: "Licença não está ativa.", status: encontrada.status });
        }
        if (produtoId && encontrada.produtoId !== produtoId) {
            return res.status(403).json({ valida: false, erro: "Licença não pertence a este aplicativo." });
        }

        const dispositivoHash = hashDispositivo(dispositivoId);

        // Primeira ativação vincula a licença ao dispositivo.
        if (dispositivoHash && !encontrada.dispositivoHash) {
            await firebasePatch(`licencas/${encontrada.id}`, {
                dispositivoHash,
                ativacoes: Number(encontrada.ativacoes || 0) + 1,
                primeiraAtivacaoEm: Date.now(),
                ultimaValidacaoEm: Date.now()
            });
        } else if (dispositivoHash && encontrada.dispositivoHash !== dispositivoHash) {
            return res.status(403).json({
                valida: false,
                erro: "Esta licença já está vinculada a outro dispositivo.",
                codigo: "DISPOSITIVO_DIFERENTE"
            });
        } else {
            await firebasePatch(`licencas/${encontrada.id}`, { ultimaValidacaoEm: Date.now() });
        }

        res.json({
            valida: true,
            status: "ativa",
            licencaId: encontrada.id,
            produtoId: encontrada.produtoId
        });
    } catch (erro) {
        console.error("ERRO VALIDANDO LICENÇA:", erro);
        res.status(500).json({ valida: false, erro: "Erro interno ao validar licença." });
    }
});

// ============================================================
// LICENÇA — TRANSFERÊNCIA CONTROLADA
// ============================================================
// Não transfere a licença automaticamente. Revoga a licença antiga
// e exige nova compra/licença para o novo comprador.
// ============================================================

app.post("/api/licenca/:licencaId/transferir", async (req, res) => {
    try {
        const licencaId = texto(req.params.licencaId);
        const novoCompradorId = texto(req.body.novoCompradorId);

        if (!licencaId || !novoCompradorId) {
            return res.status(400).json({ sucesso: false, erro: "Licença e novo comprador são obrigatórios." });
        }

        const licenca = await firebaseGet(`licencas/${licencaId}`);
        if (!licenca) return res.status(404).json({ sucesso: false, erro: "Licença não encontrada." });
        if (licenca.status !== "ativa") return res.status(409).json({ sucesso: false, erro: "Licença não está ativa." });

        const agora = Date.now();

        await firebasePatch(`licencas/${licencaId}`, {
            status: "transferida",
            transferidaEm: agora,
            atualizadoEm: agora
        });

        res.json({
            sucesso: true,
            status: "transferida",
            mensagem: "A licença anterior foi encerrada. O novo comprador precisa adquirir uma nova licença."
        });
    } catch (erro) {
        console.error("ERRO TRANSFERÊNCIA:", erro);
        res.status(500).json({ sucesso: false, erro: erro.message });
    }
});


// ============================================================
// LOGIN DO VENDEDOR — FIREBASE AUTH
// ============================================================
app.post("/api/login-vendedor", async (req, res) => {
    try {
        const email = texto(req.body.email).toLowerCase();
        const senha = String(req.body.senha || "");

        if (!email || !senha) {
            return res.status(400).json({
                sucesso: false,
                erro: "Informe e-mail e senha."
            });
        }

        if (!FIREBASE_WEB_API_KEY) {
            return res.status(500).json({
                sucesso: false,
                erro: "FIREBASE_WEB_API_KEY não configurada."
            });
        }

        const authResponse = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    password: senha,
                    returnSecureToken: true
                })
            }
        );

        const authData = await authResponse.json().catch(() => ({}));

        if (!authResponse.ok || !authData.localId) {
            return res.status(401).json({
                sucesso: false,
                erro: "E-mail ou senha inválidos."
            });
        }

        const vendedores = await firebaseGet("vendedores") || {};
        let vendedorId = null;
        let vendedor = null;

        for (const [id, dados] of Object.entries(vendedores)) {
            if (String(dados?.email || "").trim().toLowerCase() === email) {
                vendedorId = id;
                vendedor = dados;
                break;
            }
        }

        if (!vendedorId || !vendedor) {
            return res.status(403).json({
                sucesso: false,
                erro: "Cadastro de vendedor não encontrado."
            });
        }

        const bloqueado = vendedor.bloqueado === true || vendedor.banido === true;
        const aprovado = vendedor.aprovado === true ||
            ["aprovado", "ativo"].includes(String(vendedor.status || "").toLowerCase());

        if (bloqueado) {
            return res.status(403).json({
                sucesso: false,
                erro: "Seu cadastro de vendedor está bloqueado."
            });
        }

        if (!aprovado) {
            return res.status(403).json({
                sucesso: false,
                erro: "Seu cadastro ainda não foi aprovado pelo administrador."
            });
        }

        return res.json({
            sucesso: true,
            vendedorId,
            nome: vendedor.nome || "Vendedor",
            email,
            redirect: `/central-do-vendedor?vendedorId=${encodeURIComponent(vendedorId)}`
        });
    } catch (erro) {
        console.error("ERRO LOGIN VENDEDOR:", erro);
        return res.status(500).json({
            sucesso: false,
            erro: "Não foi possível realizar o login."
        });
    }
});

// ============================================================
// PÁGINAS
// ============================================================

function servirPagina(rota, nomes) {
    app.get(rota, (req, res) => {
        const enviar = indice => {
            if (indice >= nomes.length) {
                return res.status(404).send("Arquivo não encontrado.");
            }

            const arquivo = path.join(__dirname, nomes[indice]);
            res.sendFile(arquivo, erro => {
                if (erro && !res.headersSent) enviar(indice + 1);
            });
        };
        enviar(0);
    });
}

servirPagina("/central-do-vendedor", [
    "central-do-vendedor.html",
    "central do vendedor.html",
    "central do vendedor corrigida.html"
]);

servirPagina("/admin", ["admin.html"]);
servirPagina("/produto", ["produto.html"]);
servirPagina("/pagamento", ["pagamento.html"]);
servirPagina("/pagamento-sucesso", ["pagamento-sucesso.html"]);
servirPagina("/carrinho", ["Carrio.html", "carrinho.html"]);
servirPagina("/cadastro-vendedor", ["cadastro-vendedor.html"]);
servirPagina("/login-vendedor", ["login-vendedor.html", "login vendedor.html"]);

// ============================================================
// APROVAR VENDEDOR E ENVIAR LINK DA CENTRAL POR E-MAIL
// ============================================================
app.post("/api/vendedor/:vendedorId/aprovar", async (req, res) => {
    try {
        const vendedorId = texto(req.params.vendedorId);
        if (!vendedorId) return res.status(400).json({ sucesso: false, erro: "Vendedor não informado." });

        const vendedor = await firebaseGet(`vendedores/${vendedorId}`);
        if (!vendedor) return res.status(404).json({ sucesso: false, erro: "Vendedor não encontrado." });

        const email = texto(vendedor.email);
        if (!email) return res.status(400).json({ sucesso: false, erro: "Este vendedor não possui e-mail cadastrado." });
        if (!emailTransporter) {
            return res.status(500).json({ sucesso: false, erro: "E-mail automático não configurado no servidor. Configure SMTP_HOST, SMTP_USER e SMTP_PASS no .env." });
        }

        const baseUrl = BASE_URL || `${req.protocol}://${req.get("host")}`;
        const link = `${baseUrl}/login-vendedor?vendedorId=${encodeURIComponent(vendedorId)}`;

        await firebasePatch(`vendedores/${vendedorId}`, {
            status: "aprovado",
            aprovado: true,
            aprovadoEm: Date.now(),
            aprovadoPor: "Administrador",
            atualizadoEm: Date.now()
        });

        await emailTransporter.sendMail({
            from: EMAIL_FROM,
            to: email,
            subject: "Cadastro de vendedor aprovado - Central do Vendedor",
            text: `Olá, ${vendedor.nome || "Vendedor"}!\n\nSeu cadastro de vendedor foi aprovado.\n\nAcesse sua Central do Vendedor pelo link abaixo:\n${link}\n\nAtenciosamente,\nAdministrador`,
            html: `<p>Olá, ${escapeHtml(vendedor.nome || "Vendedor")}!</p><p>Seu cadastro de vendedor foi aprovado.</p><p>Acesse sua Central do Vendedor pelo link abaixo:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Atenciosamente,<br>Administrador</p>`
        });

        res.json({ sucesso: true, email, link });
    } catch (erro) {
        console.error("Aprovar/enviar e-mail:", erro);
        res.status(500).json({ sucesso: false, erro: "Vendedor não foi aprovado/enviado por e-mail.", detalhe: erro.message });
    }
});

// ============================================================
// ATUALIZAR CENTRAL DO VENDEDOR + ENVIAR LINK POR E-MAIL
// ============================================================
app.post("/api/admin/vendedores/:id/atualizar-central", async (req, res) => {
    try {
        if (!(await validarAdminToken(req))) {
            return res.status(403).json({
                sucesso: false,
                erro: "Acesso administrativo não autorizado."
            });
        }

        const vendedorId = texto(req.params.id);
        if (!vendedorId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Vendedor não informado."
            });
        }

        const vendedor = await firebaseGet(`vendedores/${encodeURIComponent(vendedorId)}`);
        if (!vendedor) {
            return res.status(404).json({
                sucesso: false,
                erro: "Vendedor não encontrado."
            });
        }

        const status = String(vendedor.status || "").toLowerCase();
        const bloqueado = vendedor.bloqueado === true || vendedor.banido === true;

        if (vendedor.aprovado !== true && status !== "aprovado" && status !== "ativo") {
            return res.status(400).json({
                sucesso: false,
                erro: "Este vendedor ainda não foi aprovado."
            });
        }

        if (bloqueado) {
            return res.status(400).json({
                sucesso: false,
                erro: "Este vendedor está bloqueado e não pode receber a atualização da Central."
            });
        }

        const email = texto(vendedor.email).toLowerCase();
        const baseUrl = BASE_URL || `${req.protocol}://${req.get("host")}`;
        const link = `${baseUrl}/login-vendedor?vendedorId=${encodeURIComponent(vendedorId)}`;
        const agora = Date.now();

        // Registra no Firebase que a Central foi atualizada e o link foi disponibilizado.
        await firebasePatch(`vendedores/${encodeURIComponent(vendedorId)}`, {
            linkCentral: link,
            centralAtualizadaEm: agora,
            ultimaAtualizacaoCentralEm: agora,
            atualizadoEm: agora
        });

        let emailEnviado = false;
        let emailErro = "";

        if (email && emailTransporter) {
            try {
                const nome = escapeHtml(vendedor.nome || "Vendedor");

                await emailTransporter.sendMail({
                    from: EMAIL_FROM,
                    to: email,
                    subject: "Sua Central do Vendedor foi atualizada",
                    text:
                        `Olá, ${vendedor.nome || "Vendedor"}!\n\n` +
                        `A Central do Vendedor foi atualizada pela administração da loja.\n\n` +
                        `Acesse a versão atualizada pelo link abaixo:\n${link}\n\n` +
                        `Se você já estava com a Central aberta, atualize a página (Ctrl+F5) para carregar a versão mais recente.\n\n` +
                        `Atenciosamente,\nAdministrador`,
                    html:
                        `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:30px">` +
                        `<div style="max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:30px">` +
                        `<h1 style="color:#2563eb">Central atualizada 🔄</h1>` +
                        `<p>Olá, <strong>${nome}</strong>!</p>` +
                        `<p>A Central do Vendedor foi atualizada pela administração da loja.</p>` +
                        `<p>Acesse a versão mais recente pelo botão abaixo:</p>` +
                        `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 20px;border-radius:10px;font-weight:700">Abrir Central atualizada</a></p>` +
                        `<p style="font-size:13px;color:#64748b">Se a Central já estiver aberta, atualize a página com Ctrl+F5.</p>` +
                        `<p style="font-size:12px;color:#94a3b8">Atualização: ${new Date(agora).toLocaleString("pt-BR")}</p>` +
                        `</div></body></html>`
                });

                emailEnviado = true;
            } catch (erroEmail) {
                console.error("Erro ao enviar atualização da Central:", erroEmail);
                emailErro = erroEmail.message || "Erro no SMTP.";
            }
        } else {
            emailErro = !email
                ? "Este vendedor não possui e-mail cadastrado."
                : "E-mail automático não configurado no servidor. Configure SMTP_HOST, SMTP_USER e SMTP_PASS no .env.";
        }

        return res.json({
            sucesso: true,
            ok: true,
            vendedorId,
            email,
            link,
            emailEnviado,
            emailErro,
            centralAtualizadaEm: agora
        });
    } catch (erro) {
        console.error("Atualizar Central do vendedor:", erro);
        return res.status(500).json({
            sucesso: false,
            erro: "Não foi possível atualizar a Central do vendedor.",
            detalhe: erro.message
        });
    }
});

// ============================================================
// 404 API
// ============================================================

app.use("/api", (req, res) => {
    res.status(404).json({ sucesso: false, erro: "Rota API não encontrada." });
});

// ============================================================
// ERROS
// ============================================================

app.use((err, req, res, next) => {
    console.error("ERRO EXPRESS:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ sucesso: false, erro: "Erro interno do servidor." });
});

// ============================================================
// INICIAR
// ============================================================

// ============================================================
// CONFIGURAÇÃO PÚBLICA DA MAKETIPLACE
// ============================================================
app.get("/api/maketiplace/config", (_req, res) => {
    res.json({
        sucesso: true,
        plataforma: MAKETIPLACE_NOME,
        mercadoPagoModo: MP_TEST_MODE ? "teste" : "producao",
        faixas: [
            { nome: "baixo", limite: TAXA_BAIXO_LIMITE, percentual: TAXA_BAIXO_PERCENTUAL },
            { nome: "alto", limite: TAXA_ALTO_LIMITE, percentual: TAXA_ALTO_PERCENTUAL },
            { nome: "muito_alto", limite: TAXA_MUITO_ALTO_LIMITE, percentual: TAXA_MUITO_ALTO_PERCENTUAL },
            { nome: "alto_demais", acimaDe: TAXA_MUITO_ALTO_LIMITE, percentual: TAXA_ALTO_DEMAIS_PERCENTUAL }
        ]
    });
});

app.listen(PORTA, () => {
    console.log("");
    console.log("==========================================");
    console.log("        LOJA DE APLICATIVOS");
    console.log("==========================================");
    console.log(`Servidor: http://localhost:${PORTA}`);
    console.log(`Status: http://localhost:${PORTA}/status`);
    console.log(`Login do vendedor: http://localhost:${PORTA}/login-vendedor`);
    console.log(`Central do vendedor: http://localhost:${PORTA}/central-do-vendedor`);
    console.log(`Central do administrador: http://localhost:${PORTA}/admin`);
    console.log(`OAuth: ${MP_REDIRECT_URI}`);
    console.log(`Mercado Pago modo: ${MP_TEST_MODE ? "TESTE" : "PRODUÇÃO"}`);
    console.log(`Mercado Pago global: ${MP_TEST_MODE ? (MP_TEST_ACCESS_TOKEN ? "CREDENCIAL DE TESTE CONFIGURADA" : "CREDENCIAL DE TESTE AUSENTE") : (MP_ACCESS_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO")}`);
    console.log(`Firebase: ${FIREBASE_DATABASE_URL ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
    console.log("Armazenamento por vendedor: 2.500 GB");
    console.log("------------------------------------------");
    console.log(`SMTP: ${smtpConfigurado ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
    console.log(`SMTP_HOST: ${SMTP_HOST || "NÃO INFORMADO"}`);
    console.log(`SMTP_PORT: ${SMTP_PORT}`);
    console.log(`SMTP_SECURE: ${SMTP_SECURE ? "true" : "false"}`);
    console.log(`SMTP_USER: ${SMTP_USER ? "CONFIGURADO (" + SMTP_USER + ")" : "NÃO CONFIGURADO"}`);
    console.log(`SMTP_PASS: ${SMTP_PASS ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
    console.log(`EMAIL_FROM: ${EMAIL_FROM || "NÃO CONFIGURADO"}`);
    if (emailTransporter) {
        emailTransporter.verify((erro) => {
            if (erro) {
                console.error("SMTP: CONFIGURADO, MAS NÃO FOI POSSÍVEL CONECTAR/AUTENTICAR.");
                console.error(`SMTP erro: ${erro.message}`);
            } else {
                console.log("SMTP: CONFIGURADO E CONEXÃO VERIFICADA COM SUCESSO.");
            }
        });
    } else {
        console.log("SMTP: ENV INCOMPLETO — preencha SMTP_HOST, SMTP_USER e SMTP_PASS.");
    }
    console.log("OAuth PKCE: ATIVADO");
    console.log("Licenças automáticas: ATIVADAS");
    console.log("Licença manual pelo vendedor: DESATIVADA");
    console.log("------------------------------------------");
    console.log("TAXAS DA PLATAFORMA:");
    console.log("Até R$ 20,00: 5%");
    console.log("Até R$ 100,00: 8%");
    console.log("Até R$ 500,00: 12%");
    console.log("Acima de R$ 500,00: 15%");
    console.log("A taxa é descontada do valor do vendedor.");
    console.log("==========================================");
    console.log("");
});
