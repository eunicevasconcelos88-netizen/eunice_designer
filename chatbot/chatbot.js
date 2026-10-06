/* Chatbot comercial | eunicedesigner
 * Modulo independente. Fonte de verdade: Supabase. Sem IA generativa, sem APIs pagas.
 * A interpretacao e feita por termos cadastrados (category_terms), tolerando erros de digitacao.
 */
(function () {
  'use strict';
  var CFG = window.CHATBOT_CONFIG || {};
  var PLACEHOLDER = !CFG.SUPABASE_URL || /SEU-PROJETO/.test(CFG.SUPABASE_URL) || !CFG.SUPABASE_ANON_KEY || /SUA-ANON/.test(CFG.SUPABASE_ANON_KEY);
  var LOCAL = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var PREVIEW = PLACEHOLDER && LOCAL;          // prévia visual local, sem Supabase
  if (PLACEHOLDER && !LOCAL) return;           // no site publicado, sem configuração, não aparece nada
  if (!PREVIEW && !window.supabase) return;

  var sb = PREVIEW ? null : window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    // sem sessao persistida: o visitante e sempre anonimo, mesmo se a admin estiver logada no mesmo navegador
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  var LS = 'ebot_session_v1';
  var MAX_FILE = 10 * 1024 * 1024;
  var MIME = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain'
  };
  var S = {
    st: null, cats: [], terms: [], services: [], packages: [], offers: [], faqs: [],
    conv: null, lastSeq: 0, seen: {}, open: false, busy: false, syncing: false, hist: true,
    packagesShown: false, catId: null, status: 'ACTIVE', stage: 0, timer: null, wake: false
  };
  var UI = {};

  /* ---------- utilitarios ---------- */
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length, i, j, prev, cur, t;
    if (!m) return n; if (!n) return m;
    prev = []; for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) {
        t = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + t);
      }
      prev = cur;
    }
    return prev[n];
  }
  function h(tag, o, kids) {
    var e = document.createElement(tag); o = o || {};
    Object.keys(o).forEach(function (k) {
      if (k === 'cls') e.className = o[k];
      else if (k === 'text') e.textContent = o[k];
      else if (k === 'on') Object.keys(o.on).forEach(function (ev) { e.addEventListener(ev, o.on[ev]); });
      else e.setAttribute(k, o[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function safeUrl(u) {
    try { var x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch (e) { return null; }
  }
  function brl(n) { return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function hasNum(n) { return n !== null && n !== undefined && n !== '' && !isNaN(Number(n)); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function uuid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      });
  }
  function fmtDate(d) { var p = String(d || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function has(n, p) { return (' ' + n + ' ').indexOf(' ' + p + ' ') !== -1; }

  /* ---------- dados do Supabase ---------- */
  async function loadData() {
    var r = await Promise.all([
      sb.from('public_chatbot_settings').select('*').maybeSingle(),
      sb.from('categories').select('*').order('sort'),
      sb.from('category_terms').select('*'),
      sb.from('services').select('*').order('sort'),
      sb.from('packages').select('*').order('sort'),
      sb.from('special_offers').select('*'),
      sb.from('knowledge_base').select('*')
    ]);
    if (r[0].error || !r[0].data) return false;
    S.st = r[0].data; S.cats = r[1].data || []; S.terms = r[2].data || [];
    S.services = r[3].data || []; S.packages = r[4].data || []; S.offers = r[5].data || []; S.faqs = r[6].data || [];
    return true;
  }
  function catName(id) { var c = S.cats.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; }

  /* ---------- sessao / conversa ---------- */
  function resetSession() {
    S.conv = null; S.lastSeq = 0; S.seen = {}; S.packagesShown = false; S.catId = null;
  }
  async function ensureConv() {
    if (S.conv) return S.conv;
    var r = await sb.rpc('chat_start', { p_ua: navigator.userAgent });
    if (r.error) throw r.error;
    S.conv = r.data;
    startPoll();
    return S.conv;
  }
  async function post(role, content, meta, catId, items) {
    var c = await ensureConv();
    var r = await sb.rpc('chat_post', {
      p_id: c.id, p_token: c.token, p_role: role, p_content: content, p_meta: meta || {},
      p_category_id: catId || null, p_shown_items: items || null
    });
    if (r.error) throw r.error;
    return r.data;
  }

  /* ---------- sincronizacao (abandono por silencio roda no servidor) ---------- */
  async function sync(force) {
    if (!S.conv || S.syncing || (S.busy && !force)) return;
    S.syncing = true;
    try {
      var r = await sb.rpc('chat_poll', { p_id: S.conv.id, p_token: S.conv.token, p_since: S.lastSeq });
      if (r.error) { if (r.error.code === '28000' || /invalida/.test(r.error.message || '')) resetSession(); return; }
      var d = r.data, fresh = 0;
      S.status = d.status; S.stage = d.stage || 0; S.packagesShown = !!d.packages_shown; if (d.category_id) S.catId = d.category_id;
      d.messages.forEach(function (m) {
        S.lastSeq = Math.max(S.lastSeq, m.seq);
        if (S.seen[m.seq]) return;
        S.seen[m.seq] = 1;
        if (m.role === 'user') { if (S.hist) renderUser(m.content); return; }
        renderBot(m.content, m.meta || {});
        if (!S.hist && !S.open) fresh++;
      });
      S.hist = false;
      if (fresh) UI.badge.hidden = false;
    } catch (e) { /* tenta de novo no proximo ciclo */ }
    finally { S.syncing = false; }
  }
  function startPoll() {
    if (S.timer) return;
    S.timer = setInterval(function () { if (!document.hidden) sync(false); }, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(false); });
  }

  /* ---------- interpretacao da mensagem ---------- */
  var GIVEUP = ['achei caro', 'muito caro', 'caro demais', 'esta caro', 'ta caro', 'vou pensar', 'deixa para depois', 'deixa pra depois',
    'deixo para depois', 'nao quero', 'nao tenho dinheiro', 'sem dinheiro', 'vou ver depois', 'nao gostei', 'nao vou fechar',
    'desisti', 'obrigado', 'obrigada', 'fica para outra hora', 'fica pra outra hora', 'agora nao', 'depois eu vejo'];
  // respostas curtas de recusa (a mensagem inteira): tratadas como desistencia, nunca como "nao entendi"
  var NEG = ['nao', 'nao obrigado', 'nao obrigada', 'nada', 'nenhum', 'nenhuma', 'agora nao', 'ainda nao', 'por enquanto nao',
    'nao por enquanto', 'nao precisa', 'nao preciso', 'nao por agora', 'depois', 'mais tarde', 'deixa quieto', 'deixa pra la',
    'tchau', 'ate mais', 'ate logo', 'nao agora', 'nao obrigado a', 'dispenso'];
  var DISCOUNT = ['desconto', 'mais barato', 'menor preco', 'preco menor', 'melhorar o preco', 'melhora o preco', 'baixar o preco',
    'abaixar o preco', 'orcamento menor', 'meu orcamento', 'faz por menos', 'fazer por menos', 'condicao especial'];
  var GREET = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'eai', 'opa', 'tudo bem', 'hello', 'hi', 'oii', 'oie'];
  var FILEW = ['briefing', 'enviar arquivo', 'mandar arquivo', 'enviar um arquivo', 'mandar um arquivo', 'print', 'pdf', 'referencia',
    'anexo', 'anexar', 'mandar imagem', 'enviar imagem', 'enviar foto', 'mandar foto'];
  var STOP = ' a o as os e de da do das dos em um uma uns umas para pra que com meu minha seu sua voce vc eu quanto qual quais como e eh ' +
    'por favor tem tenho quero queria preciso gostaria me te se na no nas nos ao aos ou mais muito '.replace(/\s+/g, ' ');

  function any(n, list) { return list.some(function (p) { return has(n, p); }); }

  function allTerms() {
    var out = S.terms.map(function (t) { return { cat: t.category_id, tn: norm(t.term), row: t }; });
    S.services.forEach(function (s) {
      (s.related_terms || []).forEach(function (t) { if (s.category_id) out.push({ cat: s.category_id, tn: norm(t), row: { is_ambiguous: false } }); });
    });
    return out.filter(function (x) { return x.tn; });
  }

  // Retorna { cats: [ids], ambiguous: linha do termo ou null }
  function detect(text) {
    var n = norm(text), tokens = n.split(' ').filter(Boolean), matches = [];
    allTerms().forEach(function (t) {
      var ok = has(n, t.tn);
      if (!ok && t.tn.indexOf(' ') === -1) {
        ok = tokens.some(function (k) {
          if (k === t.tn + 's') return true;                                   // plural
          if (t.tn.length < 5 || k.length < 5) return false;                    // typos so em palavras maiores
          if (k.charAt(0) !== t.tn.charAt(0)) return false;
          return lev(k, t.tn) <= (t.tn.length >= 8 ? 2 : 1);
        });
      }
      if (ok) matches.push(t);
    });
    // remove termos curtos contidos em frases maiores de OUTRA categoria (ex: "pagina para anuncio")
    matches = matches.filter(function (m) {
      return !matches.some(function (o) { return o.cat !== m.cat && o.tn.length > m.tn.length && has(o.tn, m.tn); });
    });
    var cats = [];
    matches.forEach(function (m) { if (cats.indexOf(m.cat) === -1) cats.push(m.cat); });
    var amb = null;
    if (cats.length === 1) {
      var mine = matches.filter(function (m) { return m.cat === cats[0]; });
      if (mine.length && mine.every(function (m) { return m.row.is_ambiguous; })) amb = mine[0].row;
    }
    return { cats: cats, ambiguous: amb };
  }

  function matchFaq(n) {
    var tokens = n.split(' ').filter(function (t) { return t.length > 2 && STOP.indexOf(' ' + t + ' ') === -1; });
    var best = null, bestScore = 0;
    S.faqs.forEach(function (f) {
      var score = 0;
      (f.keywords || []).forEach(function (k) { var kn = norm(k); if (kn && has(n, kn)) score += 2; });
      var qt = norm(f.question).split(' ').filter(function (t) { return t.length > 2 && STOP.indexOf(' ' + t + ' ') === -1; });
      var common = qt.filter(function (t) { return tokens.indexOf(t) !== -1; }).length;
      if (qt.length && common >= 2 && common / qt.length >= 0.6) score += 2;
      if (score > bestScore) { bestScore = score; best = f; }
    });
    return bestScore >= 2 ? best : null;
  }

  /* ---------- montagem das respostas (somente com dados do banco) ---------- */
  function wab(text) { return { label: 'Falar com a profissional', action: 'whatsapp', text: text || null }; }
  function ctxDefault() {
    var n = S.catId ? catName(S.catId) : '';
    return n ? 'Gostaria de falar sobre ' + n + '.' : 'Gostaria de falar sobre meu projeto.';
  }
  function trunc(t, n) { t = String(t || '').trim(); return t.length > n ? t.slice(0, n) + '...' : t; }
  function snapPkg(p) { return { kind: 'package', name: p.name, description: p.description, image_url: p.image_url, show_details: p.show_details, price: p.price, items: p.items || [] }; }
  function snapSvc(s) { return { kind: 'service', name: s.name, description: s.description, image_url: s.image_url, show_details: s.show_details, price: s.price, items: [] }; }

  function showCategory(catId) {
    var name = catName(catId);
    var pk = S.packages.filter(function (p) { return p.category_id === catId; });
    if (pk.length) {
      return { content: 'Encontrei estas opções de ' + name + ' para você:', cards: pk.map(snapPkg), catId: catId,
        shown: pk.map(function (p) { return p.name; }).join(', ') };
    }
    var sv = S.services.filter(function (s) { return s.category_id === catId; });
    if (sv.length) {
      return { content: 'Estes são os serviços de ' + name + ' que tenho cadastrados:', cards: sv.map(snapSvc), catId: catId,
        shown: sv.map(function (s) { return s.name; }).join(', ') };
    }
    return { content: 'Para esse projeto, preciso que a profissional avalie melhor o que você precisa. Posso encaminhar você para falar diretamente com ela.',
      buttons: [wab('Gostaria de um orçamento de ' + name + '.')], catId: catId };
  }
  function complexReply(ids) {
    var names = ids.map(catName).filter(Boolean), list;
    list = names.length > 1 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1] : names[0];
    return { content: 'Pelo que você descreveu, seu projeto envolve ' + list + '. Como reúne diferentes serviços, o ideal é entender melhor sua necessidade para montar uma proposta adequada.',
      buttons: [wab('Meu projeto envolve ' + list + '. Gostaria de uma proposta.')] };
  }
  function handleChoice(btn) {
    var lab = norm(btn.label);
    var svc = S.services.filter(function (s) {
      return norm(s.name) === lab || (s.related_terms || []).some(function (t) { return norm(t) === lab; });
    })[0];
    if (svc) return { content: 'Aqui está o que tenho cadastrado sobre ' + svc.name + ':', cards: [snapSvc(svc)], catId: svc.category_id, shown: svc.name };
    var cat = S.cats.filter(function (c) { return norm(c.name) === lab; })[0];
    if (cat) return showCategory(cat.id);
    if (btn.cat && btn.cat.id) {
      var r = showCategory(btn.cat.id);
      if (r.cards && r.cards.length) r.content = 'Não tenho "' + btn.label + '" como serviço avulso cadastrado na minha base. Veja o que tenho para esse tipo de necessidade:';
      else r.content = 'Não tenho "' + btn.label + '" como serviço avulso cadastrado. ' + r.content;
      return r;
    }
    return fallbackReply(btn.label);
  }
  function fallbackReply(q) { return { content: S.st.fallback_message, buttons: [wab(q ? 'Tenho uma dúvida: "' + trunc(q, 120) + '"' : ctxDefault())] }; }
  function catButtons() { return S.cats.map(function (c) { return { label: c.name, action: 'choice' }; }); }

  var GENERIC = ['pacote', 'pacotes', 'plano', 'planos', 'valor', 'valores', 'preco', 'precos', 'tabela', 'tabela de precos', 'quanto custa',
    'quanto e', 'quanto fica', 'orcamento', 'servico', 'servicos', 'opcoes', 'catalogo', 'o que voce faz', 'o que voces fazem', 'trabalhos'];
  function isGeneric(n) {
    if (any(n, GENERIC)) return true;
    return n.split(' ').some(function (k) { return k.length >= 5 && (lev(k, 'pacote') <= 1 || lev(k, 'pacotes') <= 1 || lev(k, 'servicos') <= 1 || lev(k, 'valores') <= 1); });
  }
  function showAll() {
    var pk = S.packages.slice();
    var cards = pk.map(snapPkg), names = pk.map(function (p) { return p.name; });
    if (!pk.length) { var sv = S.services.slice(); cards = sv.map(snapSvc); names = sv.map(function (x) { return x.name; }); }
    if (!cards.length) return { content: 'Para esse projeto, preciso que a profissional avalie melhor o que você precisa. Posso encaminhar você para falar diretamente com ela.', buttons: [wab('Gostaria de um orçamento.')] };
    var ids = {}; (pk.length ? pk : S.services).forEach(function (x) { if (x.category_id) ids[x.category_id] = 1; });
    var only = Object.keys(ids).length === 1 ? Object.keys(ids)[0] : null;
    return { content: 'Estas são as opções que tenho cadastradas:', cards: cards, catId: only, shown: names.join(', ') };
  }

  async function route(text, d) {
    var n = norm(text);
    if (any(n, GIVEUP) || NEG.indexOf(n) !== -1) {
      if (S.status === 'LEAD_CAPTURED') {
        return { content: 'Seu contato já está registrado e a profissional falará com você em breve. Obrigada! 😊', buttons: [wab(ctxDefault())] };
      }
      var hasOffer = !!S.catId && S.offers.some(function (o) { return o.category_id === S.catId; });
      // 1) oferta especial ativa (ou a ultima tentativa): mensagens definidas no servidor
      if (S.catId && (S.stage === 1 || (S.stage === 0 && hasOffer))) {
        var r = await sb.rpc('chat_retention', { p_id: S.conv.id, p_token: S.conv.token, p_force: true });
        if (!r.error && r.data === true) { S.wake = true; return null; }
      }
      // 2) sem oferta (ou ja ofertado): nunca desiste do cliente, pede o contato
      sb.rpc('chat_mark_declined', { p_id: S.conv.id, p_token: S.conv.token });
      return { content: S.st.decline_message || 'Que pena, como não tenho condições especiais agora, poderia deixar seu contato? Te contatamos em breve.',
        buttons: [wab(ctxDefault()), { label: 'Deixar meu contato', action: 'lead' }] };
    }
    if (any(n, DISCOUNT)) {
      return { content: 'Podemos conversar diretamente para entender melhor o que você precisa e verificar uma solução mais adequada ao seu projeto.', buttons: [wab('Gostaria de conversar sobre condições' + (S.catId ? ' para ' + catName(S.catId) : '') + '.')] };
    }
    if (any(n, FILEW)) {
      return { content: 'Claro! Pode enviar seu briefing, referências, prints ou PDFs por aqui. Use o botão abaixo.', buttons: [{ label: '📎 Enviar arquivo', action: 'file' }] };
    }
    if (d.cats.length >= 2) return complexReply(d.cats);
    if (d.cats.length === 1) {
      if (d.ambiguous) {
        var opts = (d.ambiguous.clarify_options || []).map(function (l) { return { label: l, action: 'choice', cat: { id: d.cats[0] } }; });
        return { content: d.ambiguous.clarify_question || 'Pode me explicar melhor o que você precisa?', buttons: opts.length ? opts : catButtons(), catId: d.cats[0] };
      }
      return showCategory(d.cats[0]);
    }
    if (isGeneric(n)) return showAll();
    var faq = matchFaq(n);
    if (faq) return { content: faq.answer, buttons: [wab('Tenho uma pergunta: "' + trunc(faq.question, 120) + '"')] };
    if (n.split(' ').length <= 4 && any(n, GREET)) {
      return { content: 'Olá! Me conta o que você precisa que eu te ajudo.' };
    }
    return fallbackReply(text);
  }

  /* ---------- renderizacao ---------- */
  function scrollDown() { UI.log.scrollTop = UI.log.scrollHeight; }
  function avatar(size) {
    var a = h('div', { cls: 'ebot-av' }), url = safeUrl(S.st.bot_photo_url);
    if (url) a.appendChild(h('img', { src: url, alt: S.st.bot_name || '' }));
    else a.textContent = (S.st.bot_name || 'E').charAt(0).toUpperCase();
    return a;
  }
  function renderUser(text) { UI.log.appendChild(h('div', { cls: 'ebot-msg user', text: text })); scrollDown(); }
  function renderBot(content, meta) {
    meta = meta || {};
    if (content) UI.log.appendChild(h('div', { cls: 'ebot-msg bot', text: content }));
    if (meta.cards && meta.cards.length) {
      var wrap = h('div', { cls: 'ebot-cards' });
      meta.cards.forEach(function (c) { wrap.appendChild(renderCard(c)); });
      UI.log.appendChild(wrap);
    }
    if (meta.buttons && meta.buttons.length) {
      var row = h('div', { cls: 'ebot-btns' });
      meta.buttons.forEach(function (b) {
        row.appendChild(h('button', { cls: 'ebot-btn' + (b.action === 'whatsapp' ? ' primary' : ''), type: 'button', text: b.label,
          on: { click: function () { onButton(b, meta); } } }));
      });
      UI.log.appendChild(row);
    }
    scrollDown();
  }
  function renderCard(c) {
    var img = safeUrl(c.image_url);
    // Com imagem e "mostrar informacoes" desmarcado: so a imagem (inteira) e o botao.
    var info = (c.show_details !== false) || !img;
    var card = h('div', { cls: 'ebot-card' }), body = h('div', { cls: 'ebot-cb' });
    if (img) {
      var im = h('img', { src: img, alt: c.name || '' });
      im.addEventListener('load', scrollDown);
      card.appendChild(im);
    }
    if (info) {
      if (c.kind === 'offer') body.appendChild(h('span', { cls: 'ebot-tag', text: 'Condição especial' }));
      body.appendChild(h('h4', { text: c.name }));
      if (c.kind === 'offer') {
        if (hasNum(c.special_price)) {
          var p = h('div', { cls: 'ebot-price' });
          if (hasNum(c.normal_price)) p.appendChild(h('s', { text: brl(c.normal_price) }));
          p.appendChild(document.createTextNode(brl(c.special_price)));
          body.appendChild(p);
        }
        var txt = c.display_text || c.description;
        if (txt) body.appendChild(h('p', { text: txt }));
        if (c.condition_text) body.appendChild(h('small', { text: 'Condição: ' + c.condition_text }));
        if (c.valid_until) body.appendChild(h('small', { text: 'Válido até ' + fmtDate(c.valid_until) }));
      } else {
        body.appendChild(hasNum(c.price) ? h('div', { cls: 'ebot-price', text: brl(c.price) })
          : h('div', { cls: 'ebot-price muted', text: 'Valor a confirmar com a profissional' }));
        if (c.description) body.appendChild(h('p', { text: c.description }));
        if (c.items && c.items.length) {
          var ul = h('ul'); c.items.forEach(function (i) { ul.appendChild(h('li', { text: String(i) })); });
          body.appendChild(ul);
        }
      }
    }
    if (c.kind !== 'offer') {
      body.appendChild(h('button', { cls: 'ebot-btn primary', type: 'button', text: 'Falar com a profissional',
        on: { click: function () { openWa((c.kind === 'service' ? 'Tenho interesse no serviço ' : 'Tenho interesse no pacote ') + c.name + '.'); } } }));
    }
    if (body.childNodes.length) card.appendChild(body);
    return card;
  }
  function typing(on) {
    var t = UI.log.querySelector('.ebot-typing-wrap');
    if (on && !t) { UI.log.appendChild(h('div', { cls: 'ebot-msg bot ebot-typing ebot-typing-wrap' }, [h('i'), h('i'), h('i')])); scrollDown(); }
    if (!on && t) t.remove();
  }
  async function botSay(reply) {
    var meta = { type: 'reply' };
    if (reply.cards) meta.cards = reply.cards;
    if (reply.buttons) meta.buttons = reply.buttons;
    var seq = await post('bot', reply.content, meta, reply.catId || null, reply.shown || null);
    if (reply.shown) S.packagesShown = true;
    if (reply.catId) S.catId = reply.catId;
    if (!S.seen[seq]) { S.seen[seq] = 1; renderBot(reply.content, meta); }
  }
  function localBot(content, buttons) { renderBot(content, { buttons: buttons || null }); }

  /* ---------- acoes ---------- */
  function onButton(b, meta) {
    var oc = meta && meta.cards && meta.cards.filter(function (x) { return x.kind === 'offer'; })[0];
    if (b.action === 'whatsapp') openWa(b.text || (oc ? 'Tenho interesse na oferta especial ' + oc.name + '.' : ctxDefault()));
    else if (b.action === 'lead') showLeadForm();
    else if (b.action === 'file') UI.file.click();
    else if (b.action === 'choice') send(b.label, b);
  }
  function openWa(ctx) {
    var url = safeUrl(S.st.whatsapp_link);          // link gerado pela profissional
    if (!url) { localBot('O WhatsApp ainda não foi configurado. Deixe seu contato para a profissional falar com você.', [{ label: 'Deixar meu contato', action: 'lead' }]); return; }
    try {
      var u = new URL(url);
      // wa.me e api.whatsapp.com aceitam o parametro text: acrescenta o pacote clicado na mensagem
      if (/(^|\.)wa\.me$|(^|\.)whatsapp\.com$/.test(u.hostname)) {
        var text = u.searchParams.get('text') || S.st.whatsapp_message || '';
        if (ctx) text += (text ? ' ' : '') + ctx;
        u.searchParams.delete('text');
        var rest = u.searchParams.toString();
        if (text) u.search = (rest ? rest + '&' : '') + 'text=' + encodeURIComponent(text);
        url = u.href;
      }
    } catch (e) {}
    window.open(url, '_blank', 'noopener');
    if (S.conv) {
      var c = S.conv;
      // registra no historico qual item foi clicado (aparece em Conversas no painel)
      sb.rpc('chat_post', { p_id: c.id, p_token: c.token, p_role: 'user',
          p_content: '👆 Clicou em "Falar com a profissional"' + (ctx ? ': ' + ctx : ''), p_meta: { type: 'whatsapp_click' }, p_category_id: null, p_shown_items: null })
        .then(function (r) { if (!r.error) S.seen[r.data] = 1; })
        .then(function () { return sb.rpc('chat_set_status', { p_id: c.id, p_token: c.token, p_status: 'WHATSAPP_REDIRECTED' }); });
    }
  }
  function setBusy(v) { S.busy = v; UI.input.disabled = v; UI.sendBtn.disabled = v; UI.clip.disabled = v; }

  async function send(text, choiceBtn) {
    text = String(text || '').trim().slice(0, 1000);
    if (!text || S.busy) return;
    if (PREVIEW) { renderUser(text); localBot('Modo prévia: o visual está funcionando, mas ainda não há conexão com o Supabase. Preencha chatbot/config.js e rode o schema.sql para o atendimento funcionar.'); return; }
    setBusy(true);
    var reply = null;
    try {
      renderUser(text);
      var d = choiceBtn ? { cats: [], ambiguous: null } : detect(text);
      var catId = d.cats.length === 1 ? d.cats[0] : (choiceBtn && choiceBtn.cat ? choiceBtn.cat.id : null);
      var seq = await post('user', text, choiceBtn ? { type: 'choice' } : {}, catId, null);
      S.seen[seq] = 1;
      if (catId) S.catId = catId;
      typing(true); await delay(550);
      reply = choiceBtn ? handleChoice(choiceBtn) : await route(text, d);
      typing(false);
      if (reply) await botSay(reply);
    } catch (e) {
      typing(false);
      localBot('Tive um problema para registrar sua mensagem. Pode tentar novamente? Se preferir, fale direto com a profissional.', [wab(ctxDefault())]);
    } finally {
      setBusy(false);
    }
    if (S.wake) { S.wake = false; await sync(true); }
    UI.input.focus();
  }

  function showLeadForm() {
    if (UI.log.querySelector('.ebot-form')) return;
    var f = {
      name: h('input', { type: 'text', placeholder: 'Seu nome', maxlength: '120', autocomplete: 'name' }),
      phone: h('input', { type: 'tel', placeholder: 'WhatsApp com DDD', maxlength: '20', autocomplete: 'tel' }),
      email: h('input', { type: 'email', placeholder: 'E-mail (opcional)', maxlength: '160', autocomplete: 'email' }),
      note: h('textarea', { placeholder: 'Observação (opcional)', maxlength: '1000' }),
      ck: h('input', { type: 'checkbox' }), err: h('div', { cls: 'ebot-err' })
    };
    var submit = h('button', { cls: 'ebot-btn primary', type: 'button', text: 'Enviar meu contato' });
    var form = h('div', { cls: 'ebot-form' }, [
      f.name, f.phone, f.email, f.note,
      h('label', { cls: 'ck' }, [f.ck, h('span', { text: S.st.lead_consent_text || 'Autorizo o contato da profissional pelos dados informados.' })]),
      f.err, submit
    ]);
    submit.addEventListener('click', async function () {
      var phone = f.phone.value.replace(/\D/g, '');
      if (f.name.value.trim().length < 2) { f.err.textContent = 'Informe seu nome.'; return; }
      if (phone.length < 10) { f.err.textContent = 'Informe o WhatsApp com DDD.'; return; }
      if (f.email.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value)) { f.err.textContent = 'E-mail inválido.'; return; }
      if (!f.ck.checked) { f.err.textContent = 'Marque a autorização para continuar.'; return; }
      submit.disabled = true; f.err.textContent = '';
      try {
        var c = await ensureConv();
        var r = await sb.rpc('chat_save_lead', {
          p_id: c.id, p_token: c.token, p_name: f.name.value, p_phone: phone, p_email: f.email.value,
          p_note: f.note.value, p_consent: true
        });
        if (r.error) throw r.error;
        form.remove();
        S.status = 'LEAD_CAPTURED';
        await botSay({ content: 'Pronto! Seu contato foi registrado. Se quiser, você também pode falar direto com a profissional pelo WhatsApp.', buttons: [wab(ctxDefault())] });
      } catch (e) { submit.disabled = false; f.err.textContent = 'Não consegui salvar agora. Tente novamente.'; }
    });
    UI.log.appendChild(form); scrollDown(); f.name.focus();
  }

  async function onFile(file) {
    if (!file) return;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!MIME[ext]) { localBot('Esse formato não é aceito. Envie PDF, JPG, PNG, WEBP, DOC, DOCX ou TXT.'); return; }
    if (file.size > MAX_FILE) { localBot('O arquivo passa de 10 MB. Envie uma versão menor ou fale direto com a profissional.', [wab('Quero enviar um arquivo grande e preciso de ajuda.')]); return; }
    setBusy(true);
    var note = h('div', { cls: 'ebot-msg bot', text: 'Enviando ' + file.name + '...' });
    UI.log.appendChild(note); scrollDown();
    try {
      var c = await ensureConv();
      var path = c.id + '/' + uuid() + '.' + ext;
      var up = await sb.storage.from('briefings').upload(path, file, { contentType: MIME[ext], upsert: false });
      if (up.error) throw up.error;
      var r = await sb.rpc('chat_register_file', { p_id: c.id, p_token: c.token, p_name: file.name, p_mime: MIME[ext], p_size: file.size, p_path: path });
      if (r.error) throw r.error;
      S.seen[r.data] = 1;
      note.remove(); renderUser('📎 ' + file.name);
      await botSay({ content: 'Arquivo recebido e anexado ao seu atendimento. Pode enviar outros ou me contar o que você precisa.', buttons: [wab('Enviei um arquivo pelo assistente e gostaria de falar sobre meu projeto.')] });
    } catch (e) {
      note.remove();
      localBot('Não consegui enviar o arquivo agora. Tente novamente ou fale direto com a profissional.', [wab(ctxDefault())]);
    } finally { setBusy(false); UI.file.value = ''; }
  }

  /* ---------- interface ---------- */
  function toggle(open) {
    S.open = open; UI.panel.hidden = !open; UI.fab.hidden = open && window.innerWidth <= 520;
    if (open) { UI.badge.hidden = true; scrollDown(); sync(false); setTimeout(function () { UI.input.focus(); }, 50); }
  }
  function build() {
    var root = h('div', { id: 'ebot-root' });
    UI.badge = h('span', { cls: 'ebot-badge' }); UI.badge.hidden = true;
    UI.fab = h('button', { cls: 'ebot-fab', type: 'button', 'aria-label': 'Abrir atendimento', on: { click: function () { toggle(true); } } }, [avatar(), UI.badge]);
    UI.log = h('div', { cls: 'ebot-log', role: 'log', 'aria-live': 'polite' });
    UI.input = h('input', { type: 'text', placeholder: 'Digite sua mensagem...', maxlength: '1000', 'aria-label': 'Mensagem' });
    UI.sendBtn = h('button', { cls: 'ebot-ico send', type: 'button', 'aria-label': 'Enviar', text: '➤' });
    UI.clip = h('button', { cls: 'ebot-ico', type: 'button', 'aria-label': 'Enviar arquivo', title: 'Enviar arquivo', text: '📎' });
    UI.file = h('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.txt' }); UI.file.hidden = true;
    UI.clip.addEventListener('click', function () { UI.file.click(); });
    UI.file.addEventListener('change', function () { onFile(UI.file.files[0]); });
    UI.sendBtn.addEventListener('click', function () { var v = UI.input.value; UI.input.value = ''; send(v); });
    UI.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); var v = UI.input.value; UI.input.value = ''; send(v); }
    });
    var head = h('div', { cls: 'ebot-head' }, [
      avatar(),
      h('div', {}, [h('b', { text: S.st.bot_name || 'Atendimento' }), h('small', {}, [h('i'), document.createTextNode('Assistente comercial')])]),
      h('button', { cls: 'ebot-x', type: 'button', 'aria-label': 'Fechar', text: '×', on: { click: function () { toggle(false); } } })
    ]);
    UI.panel = h('div', { cls: 'ebot-panel', role: 'dialog', 'aria-label': 'Atendimento' }, [
      head, UI.log, h('div', { cls: 'ebot-in' }, [UI.clip, UI.input, UI.sendBtn, UI.file])
    ]);
    UI.panel.hidden = true;
    root.appendChild(UI.fab); root.appendChild(UI.panel);
    document.body.appendChild(root);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) toggle(false); });
    // boas-vindas (local, nao grava no banco)
    renderBot(S.st.welcome_message, {});
  }

  async function init() {
    if (PREVIEW) {
      S.st = { enabled: true, bot_name: 'Eunice', bot_photo_url: null, whatsapp_number: '', whatsapp_message: '',
        welcome_message: 'Olá! Sou o assistente da Eunice. Me conta o que você precisa e eu mostro as opções disponíveis.' };
      build(); return;
    }
    var ok = false;
    try { ok = await loadData(); } catch (e) {}
    if (!ok || !S.st.enabled) return;
    build();
    S.hist = false;   // cada visita comeca um chat novo; o historico anterior fica arquivado no painel
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
