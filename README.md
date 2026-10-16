# FALAMIGO BACKEND v1.0 — Trial 7 dias + Pagamento unico R$ 9,90 (Asaas)

Servidor intermediario seguro. Ele — e somente ele — controla o trial, cria cobrancas
no Asaas e libera o acesso pago apos webhook validado.

## 1. Instalacao local
    cd backend
    cp env.example .env        # preencha as variaveis
    npm install
    npm start                  # http://localhost:3000

## 2. Credenciais Asaas (sandbox primeiro!)
1. Crie conta em https://sandbox.asaas.com  (ambiente de testes, dinheiro falso)
2. Painel -> Integracao -> copie a **API Key** para `ASAAS_API_KEY`
3. Painel -> Webhooks -> defina um **token de autenticacao** -> copie para `ASAAS_WEBHOOK_TOKEN`
4. No mesmo Webhooks, cadastre a URL: `https://SEU-DOMINIO/api/webhooks/asaas`
   (use ngrok localmente:  ngrok http 3000)
5. Somente depois de todos os testes: troque `ASAAS_ENV=production` e use a key de producao.

## 3. Deploy em HTTPS (obrigatorio para webhook)
- Render.com / Railway.app: novo Web Service a partir desta pasta, start `node server.js`,
  variaveis de ambiente do `.env`. HTTPS incluso.
- GitHub Pages NAO roda Node.js: o front continua la, o back fica no Render/Railway.

## 4. Ligacao com o front-end
No `falamigo_v4_dinobo_trial.html`, linha `DINOBO_SERVER_URL`:
    var DINOBO_SERVER_URL = 'https://seu-backend.onrender.com';

## 5. Fluxo validado
1. Usuario entra -> `/api/auth/register` (trial_start gravado NO SERVIDOR)
2. Front chama `/api/access/status` -> state: TRIAL_ACTIVE / TRIAL_EXPIRED / PAYMENT_PENDING / PAID_UNLOCKED
3. "Desbloquear" -> `/api/payments/create` -> redireciona ao `invoiceUrl` (checkout Asaas)
4. Cliente paga -> Asaas dispara webhook -> token validado -> evento idempotente ->
   status PAYMENT RECEIVED/CONFIRMED -> `users.paid = 1`
5. Front reconsulta `/api/access/status` -> PAID_UNLOCKED (em qualquer dispositivo)
Limpar localStorage ou mudar a data do aparelho NAO reinicia o trial: a data mora no banco.

## 6. Testes (checklist da regra 14)
- [ ] Registro/login retorna JWT e state TRIAL_ACTIVE
- [ ] Novo login no dia 8 retorna TRIAL_EXPIRED (mesmo apos limpar navegador)
- [ ] /api/payments/create gera cobranca de exatamente R$ 9,90 (verifique no painel sandbox)
- [ ] Pagamento pendente -> state PAYMENT_PENDING, app segue bloqueado
- [ ] Webhook RECEIVED (simule no painel Asaas) -> users.paid=1 -> PAID_UNLOCKED
- [ ] Reenviar o mesmo webhook -> resposta {duplicate:true}, sem beneficio duplo
- [ ] Webhook com token errado -> 401
- [ ] Login em outro dispositivo -> acesso recuperado
- [ ] Grep no front: nenhuma ocorrencia de ASAAS_API_KEY (seguranca)
- [ ] Todas as abas/funcoes do Falamigo seguem funcionando apos a atualizacao

## 7. Estrutura
    backend/
      server.js      API completa (auth, access, payments, webhook)
      package.json
      env.example    modelo de configuracao (sem credenciais reais)
      schema.sql     equivalente PostgreSQL para producao
