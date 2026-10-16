/* ============================================================================
   FALAMIGO BACKEND v1.0 — Trial 7 dias + Desbloqueio unico R$ 9,90 via Asaas
   Node.js 18+ | Express | SQLite (better-sqlite3)
   ----------------------------------------------------------------------------
   REGRA DE OURO: a chave ASAAS_API_KEY fica SOMENTE neste servidor
   (variavel de ambiente). NUNCA colocar no HTML/JS publico.
   Ambientes separados: ASAAS_ENV=sandbox (teste) | production (real).
   ============================================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const axios = require('axios');

const app = express();
app.use(cors({ origin: (process.env.FRONTEND_URL || '*').split(',') }));
app.use(express.json());

/* ---------- BANCO (SQLite em arquivo; troque por PostgreSQL em producao) ---------- */
const db = new Database(process.env.DB_FILE || './falamigo.db');
db.pragma('journal_mode = WAL');
db.exec(
  "CREATE TABLE IF NOT EXISTS users (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "email TEXT UNIQUE NOT NULL," +
  "pass_hash TEXT NOT NULL," +
  "trial_start TEXT NOT NULL," +
  "paid INTEGER NOT NULL DEFAULT 0," +
  "paid_at TEXT," +
  "asaas_customer_id TEXT);" +
  "CREATE TABLE IF NOT EXISTS payments (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "user_id INTEGER NOT NULL REFERENCES users(id)," +
  "asaas_payment_id TEXT UNIQUE," +
  "value REAL NOT NULL," +
  "status TEXT NOT NULL DEFAULT 'PENDING'," +
  "created_at TEXT NOT NULL);" +
  "CREATE TABLE IF NOT EXISTS processed_events (" +
  "event_id TEXT PRIMARY KEY," +
  "processed_at TEXT NOT NULL);"
);

const TRIAL_DAYS   = parseInt(process.env.TRIAL_DIAS || '7', 10);
const UNLOCK_VALUE = parseFloat(process.env.UNLOCK_VALUE || '9.90');
const ASAAS_BASE   = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';
const asaas = axios.create({
  baseURL: ASAAS_BASE,
  headers: { access_token: process.env.ASAAS_API_KEY || '' },
  timeout: 15000
});

/* ---------- HELPERS ---------- */
function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Nao autenticado' }); }
}
const getUser = (uid) => db.prepare('SELECT * FROM users WHERE id = ?').get(uid);

function computeState(user) {
  const start = new Date(user.trial_start).getTime();
  const end = start + TRIAL_DAYS * 86400000;
  const remaining = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
  let state;
  if (user.paid) state = 'PAID_UNLOCKED';
  else {
    const pend = db.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status IN ('PENDING','AWAITING_CUSTOMER')"
    ).get(user.id).n;
    if (pend > 0) state = 'PAYMENT_PENDING';
    else if (remaining > 0) state = 'TRIAL_ACTIVE';
    else state = 'TRIAL_EXPIRED';
  }
  return {
    state: state,
    trialStart: user.trial_start,
    trialEnd: new Date(end).toISOString(),
    daysRemaining: remaining,
    price: UNLOCK_VALUE
  };
}

async function ensureAsaasCustomer(user) {
  if (user.asaas_customer_id) return user.asaas_customer_id;
  const r = await asaas.post('/customers', { name: user.email, email: user.email });
  const cid = r.data.id;
  db.prepare('UPDATE users SET asaas_customer_id = ? WHERE id = ?').run(cid, user.id);
  return cid;
}

/* ---------- AUTH ---------- */
app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalido' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha curta (min. 6)' });
  if (getUser && db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'E-mail ja cadastrado. Faca login.' });
  const hash = await bcrypt.hash(password, 10);
  const trialStart = new Date().toISOString();
  const info = db.prepare('INSERT INTO users (email, pass_hash, trial_start) VALUES (?,?,?)')
    .run(email, hash, trialStart);
  const user = { id: info.lastInsertRowid, email: email, trial_start: trialStart, paid: 0 };
  res.json({ token: sign(user), state: computeState(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.pass_hash)))
    return res.status(401).json({ error: 'Credenciais invalidas' });
  res.json({ token: sign(user), state: computeState(user) });
});

/* ---------- STATUS DE ACESSO (servidor = autoridade do trial) ---------- */
app.get('/api/access/status', auth, (req, res) => {
  const user = getUser(req.user.uid);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  res.json(computeState(user)); /* limpar o navegador/relgio do aparelho NAO muda esse resultado */
});

/* ---------- PAGAMENTOS ---------- */
app.post('/api/payments/create', auth, async (req, res) => {
  try {
    const user = getUser(req.user.uid);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
    if (user.paid) return res.json({ alreadyPaid: true });
    /* idempotencia: reaproveita cobranca pendente existente */
    const existing = db.prepare(
      "SELECT * FROM payments WHERE user_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1"
    ).get(user.id);
    if (existing && existing.asaas_payment_id) {
      const r = await asaas.get('/payments/' + existing.asaas_payment_id);
      if (r.data.status === 'PENDING') return res.json({ paymentId: existing.asaas_payment_id, checkoutUrl: r.data.invoiceUrl });
    }
    const customerId = await ensureAsaasCustomer(user);
    const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const r = await asaas.post('/payments', {
      customer: customerId,
      billingType: 'UNDEFINED', /* habilita Pix/boleto/cartao conforme conta Asaas */
      value: UNLOCK_VALUE,      /* valor exato validado no servidor */
      dueDate: due,
      description: 'Falamigo - Desbloqueio permanente (pagamento unico)',
      externalReference: 'user:' + user.id
    });
    db.prepare('INSERT INTO payments (user_id, asaas_payment_id, value, status, created_at) VALUES (?,?,?,?,?)')
      .run(user.id, r.data.id, UNLOCK_VALUE, r.data.status, new Date().toISOString());
    res.json({ paymentId: r.data.id, checkoutUrl: r.data.invoiceUrl });
  } catch (e) {
    console.error('create payment:', e.response ? e.response.data : e.message);
    res.status(502).json({ error: 'Erro ao gerar cobranca. Tente novamente.' });
  }
});

app.get('/api/payments/:id/status', auth, async (req, res) => {
  try {
    const user = getUser(req.user.uid);
    const pay = db.prepare('SELECT * FROM payments WHERE asaas_payment_id = ? AND user_id = ?')
      .get(req.params.id, req.user.uid);
    if (!pay) return res.status(404).json({ error: 'Cobranca nao encontrada' });
    const r = await asaas.get('/payments/' + req.params.id); /* confirma estado REAL na API oficial */
    const st = r.data.status;
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(st, pay.id);
    if ((st === 'RECEIVED' || st === 'CONFIRMED') && !user.paid) {
      db.prepare('UPDATE users SET paid = 1, paid_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    }
    res.json({ paymentStatus: st, state: computeState(getUser(req.user.uid)) });
  } catch (e) {
    res.status(502).json({ error: 'Falha ao consultar cobranca' });
  }
});

/* ---------- WEBHOOK ASAAS (token + idempotencia + confirmacao) ---------- */
app.post('/api/webhooks/asaas', (req, res) => {
  /* 1. autenticidade: token configurado no painel do Asaas */
  if ((req.headers.authorization || '') !== (process.env.ASAAS_WEBHOOK_TOKEN || ''))
    return res.status(401).json({ error: 'Webhook nao autorizado' });
  const ev = req.body || {};
  const eventId = String(ev.id || '');
  if (!eventId) return res.status(400).json({ error: 'Evento sem id' });
  /* 2. idempotencia: evento repetido nao concede beneficio duplo */
  try {
    db.prepare('INSERT INTO processed_events (event_id, processed_at) VALUES (?,?)')
      .run(eventId, new Date().toISOString());
  } catch (e) {
    return res.json({ ok: true, duplicate: true });
  }
  const payment = ev.payment || {};
  db.prepare('UPDATE payments SET status = ? WHERE asaas_payment_id = ?').run(payment.status || 'UNKNOWN', payment.id);
  /* 3. so libera em pagamento efetivamente recebido */
  if (payment.status === 'RECEIVED' || payment.status === 'CONFIRMED') {
    const ref = String(payment.externalReference || '');
    const m = ref.match(/user:(\d+)/);
    if (m) {
      const uid = parseInt(m[1], 10);
      const u = getUser(uid);
      if (u && !u.paid) {
        db.prepare('UPDATE users SET paid = 1, paid_at = ? WHERE id = ?').run(new Date().toISOString(), uid);
        console.log('ACESSO LIBERADO user', uid, 'pagamento', payment.id);
      }
    }
  }
  /* chargeback/estorno: revoga conforme regras comerciais */
  if (payment.status === 'REFUNDED' || payment.status === 'CHARGEBACK') {
    const m = String(payment.externalReference || '').match(/user:(\d+)/);
    if (m) db.prepare('UPDATE users SET paid = 0 WHERE id = ?').run(parseInt(m[1], 10));
  }
  res.json({ ok: true });
});

/* ---------- SAUDE ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.ASAAS_ENV || 'sandbox' }));

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => console.log('Falamigo backend ouvindo na porta ' + PORT + ' (' + (process.env.ASAAS_ENV || 'sandbox') + ')'));
