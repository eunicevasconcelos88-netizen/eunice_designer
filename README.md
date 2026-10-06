# Chatbot comercial | eunicedesigner

Landing page original preservada. Foram acrescentados apenas 4 linhas no index.html (antes de </body>) e as pastas abaixo.

```
index.html              (original + 4 linhas do chatbot)
vercel.json             (somente bloqueia indexação do /admin)
chatbot/config.js       (URL e anon key PÚBLICA do Supabase)
chatbot/chatbot.css
chatbot/chatbot.js
admin/index.html        (painel em /admin)
supabase/schema.sql     (tabelas, RLS, funções, Storage, termos iniciais)
```

Análise do projeto atual: site estático (um index.html), sem framework, sem rotas, sem Supabase e sem variáveis de ambiente.
Por isso o chatbot foi feito em JavaScript puro, sem etapa de build, e o /admin é uma página estática dentro do mesmo projeto.

## 1. Criar o Supabase (gratuito)
1. Acesse supabase.com, crie um projeto.
2. SQL Editor > New query > cole TODO o conteúdo de `supabase/schema.sql` > Run.
3. Authentication > Users > Add user (seu e-mail e senha, marque Auto Confirm).
4. Authentication > Sign In / Providers > Email: desative "Allow new users to sign up" (ninguém mais cria conta).
5. No SQL Editor, torne seu usuário administrador (troque o e-mail):
   `insert into public.admins(user_id) select id from auth.users where email = 'SEU-EMAIL@exemplo.com';`
6. Project Settings > API: copie "Project URL" e a chave "anon public".

## 2. Configurar o projeto
Edite `chatbot/config.js` com a URL e a anon key. A anon key é pública por natureza e fica protegida por RLS.
A `service_role` NUNCA é usada e não deve ser colocada em nenhum arquivo.

## 3. Publicar na Vercel
Copie estas pastas/arquivos para o repositório do projeto (GitHub) e faça commit. A Vercel publica sozinha.
Se o deploy for por upload, envie a pasta inteira.
Não precisa de variáveis de ambiente na Vercel, pois não há servidor nem build.

## 4. Cadastrar tudo em /admin
Acesse seusite.vercel.app/admin e entre.
- Chatbot: nome, foto, mensagens, WHATSAPP_NUMBER, mensagem do WhatsApp, e-mail, tempo de silêncio.
- Categorias: já vêm 4 criadas.
- Palavras / Termos: já vêm termos iniciais. Acrescente os que seus clientes usam.
- Pacotes e Serviços: nome, categoria, preço, itens, imagem. Sem preço, o chatbot encaminha para você.
- Ofertas especiais: categoria, preço normal e especial, validade, ativa. Aparecem só na retenção.
- FAQ: respostas autorizadas.
- Leads, Arquivos recebidos, Conversas: acompanhamento.

## Regras do abandono de 3 minutos
O estado fica no banco (tabela conversations). A função `chat_poll` verifica o silêncio e grava a mensagem uma única vez
(a linha da conversa é travada, então não duplica). Ela roda a cada 15 segundos com a página aberta.
Para disparar mesmo com a página fechada, ative a extensão pg_cron (Database > Extensions) e rode:
`select cron.schedule('chat-sweep', '* * * * *', 'select public.chat_sweep()');`
Sequência: 1) pacotes mostrados, 2) 3 minutos sem resposta, 3) oferta (ou aviso sem oferta), 4) última tentativa, 5) encerra.

## Segurança
- Visitantes não leem nem alteram conversas, leads ou arquivos diretamente. Só pelas funções, com token secreto da sessão.
- Bucket `briefings` privado: visitante só envia, só o admin baixa (link temporário). Limite de 10 MB e tipos permitidos.
- Textos do banco são exibidos como texto puro (sem HTML), evitando XSS.
- Recomendação: no Supabase, ative Captcha em Authentication > Attack Protection e acompanhe o uso no painel.

## E-mail (opcional e gratuito)
Cada novo lead e arquivo cria um evento em `notification_events`. Para receber e-mail sem pagar, use um Database Webhook
do Supabase apontando para um automatizador gratuito (ex.: Make ou n8n) que envia para o seu e-mail.
O chatbot funciona normalmente sem isso.
