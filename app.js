/* =========================================================================
   «Мой заказ» — Telegram Mini App.
   Управление повседневными делами по логике официантского приложения iiko:
   столы → категории, блюда → задачи, заказ → список дел на контекст.

   Архитектура (чистый ES6+, без фреймворков):
     1. tg          — обёртка над Telegram.WebApp (тема, кнопки, хаптика)
     2. DB          — состояние приложения + сохранение в localStorage
     3. nav         — стек экранов (для корректной работы кнопки «Назад»)
     4. render*     — функции отрисовки экранов
     5. модалки     — модификаторы, категория, задача, настройки
   ========================================================================= */

'use strict';

/* ----------------------------------------------------------------------- */
/* 0. МЕЛКИЕ УТИЛИТЫ                                                        */
/* ----------------------------------------------------------------------- */

// Короткий querySelector
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Генерация уникального идентификатора
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Экранирование пользовательского текста (защита от вставки HTML)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ----------------------------------------------------------------------- */
/* 1. TELEGRAM WEBAPP                                                       */
/* ----------------------------------------------------------------------- */

// Реальный объект внутри Telegram; в обычном браузере его нет — работаем без него.
const TG = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const tg = {
  api: TG,
  // Внутри Telegram, если доступны методы инициализации
  inside: !!(TG && TG.initData !== undefined && TG.platform && TG.platform !== 'unknown'),

  init() {
    if (!TG) return;
    try { TG.ready(); } catch (e) {}
    try { TG.expand(); } catch (e) {}            // развернуть на весь экран
    try { TG.disableVerticalSwipes && TG.disableVerticalSwipes(); } catch (e) {}
    this.applyTheme();
    // Реагируем на смену темы пользователем «на лету»
    TG.onEvent && TG.onEvent('themeChanged', () => this.applyTheme());
  },

  // Переносим themeParams Telegram в CSS-переменные интерфейса
  applyTheme() {
    if (!TG || !TG.themeParams) return;
    const p = TG.themeParams;
    const root = document.documentElement.style;
    const set = (cssVar, value) => { if (value) root.setProperty(cssVar, value); };

    set('--bg',           p.bg_color);
    set('--text',         p.text_color);
    set('--hint',         p.hint_color || p.subtitle_text_color);
    set('--link',         p.link_color || p.accent_text_color);
    set('--button',       p.button_color);
    set('--button-text',  p.button_text_color);
    set('--secondary-bg', p.secondary_bg_color || p.section_bg_color);
    set('--section-bg',   p.section_bg_color || p.bg_color);
    set('--header-bg',    p.header_bg_color || p.button_color);
    set('--destructive',  p.destructive_text_color);

    document.body.style.background = p.secondary_bg_color || p.bg_color || '';
  },

  // Цвет шапки WebApp под текущий раздел
  setHeaderColor(color) {
    if (!TG || !TG.setHeaderColor) return;
    try {
      // Telegram принимает 'bg_color' / 'secondary_bg_color' либо HEX (Bot API 6.9+)
      if (/^#/.test(color)) TG.setHeaderColor(color);
      else TG.setHeaderColor(color);
    } catch (e) {}
  },

  // --- MainButton: подтверждение заказа ---
  mainButton(text, onClick) {
    if (!TG || !TG.MainButton) return;
    const mb = TG.MainButton;
    mb.setText(text);
    mb.offClick(this._mbHandler);
    this._mbHandler = () => onClick();
    mb.onClick(this._mbHandler);
    mb.show();
  },
  hideMainButton() { if (TG && TG.MainButton) TG.MainButton.hide(); },

  // --- BackButton: возврат на предыдущий экран ---
  showBackButton() {
    if (!TG || !TG.BackButton) return;
    TG.BackButton.show();
  },
  hideBackButton() { if (TG && TG.BackButton) TG.BackButton.hide(); },
  onBack(fn) { if (TG && TG.BackButton) TG.BackButton.onClick(fn); },

  // Тактильная отдача (если поддерживается)
  haptic(type = 'light') {
    if (!TG || !TG.HapticFeedback) return;
    try {
      if (type === 'success' || type === 'error' || type === 'warning')
        TG.HapticFeedback.notificationOccurred(type);
      else
        TG.HapticFeedback.impactOccurred(type);
    } catch (e) {}
  },

  // Диалог подтверждения (нативный в Telegram, иначе системный confirm)
  confirm(message, cb) {
    if (TG && TG.showConfirm) { TG.showConfirm(message, (ok) => cb(ok)); }
    else { cb(window.confirm(message)); }
  },
};

/* ----------------------------------------------------------------------- */
/* 2. ДАННЫЕ + ХРАНИЛИЩЕ                                                    */
/* ----------------------------------------------------------------------- */

const STORE_KEY = 'myorder_db_v1';

// Структура заранее готова к будущей отправке на сервер:
// достаточно сериализовать DB.state и сделать POST.
const DB = {
  state: null,

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { this.state = JSON.parse(raw); return; }
    } catch (e) { /* повреждённые данные — пересоздаём */ }
    this.state = this.seed();
    this.save();
  },

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); }
    catch (e) { toast('Не удалось сохранить — нет места в хранилище'); }
  },

  // Полный сброс к стандартному набору
  reset() { this.state = this.seed(); this.save(); },

  // Заводские данные: версия, настройки, категории с меню, пустые корзина/история
  seed() {
    return {
      version: 1,
      settings: { unit: 'time' },                // 'time' (минуты) | 'points' (баллы)
      cart: { categoryId: null, items: [] },     // текущий заказ
      history: [],                               // завершённые заказы
      categories: [
        cat('Утро', '🌅', 'c1', [
          sec('Быстрое', [
            dish('💧', 'Выпить воды', 2),
            dish('🤸', 'Зарядка', 10),
            dish('🚿', 'Душ', 10),
          ]),
          sec('Важное', [
            dish('🍳', 'Завтрак', 20),
            dish('📝', 'План на день', 10),
          ]),
        ]),
        cat('Работа', '💼', 'c2', [
          sec('Быстрые дела', [
            dish('📧', 'Разобрать почту', 15),
            dish('☎️', 'Созвон', 30),
          ]),
          sec('Важные дела', [
            dish('🎯', 'Главная задача', 90),
            dish('📊', 'Отчёт', 60),
          ]),
        ]),
        cat('Дом', '🏠', 'c3', [
          sec('Быстрое', [
            dish('🍽️', 'Помыть посуду', 15),
            dish('🪴', 'Полить цветы', 5),
          ]),
          sec('Уборка', [
            dish('🧹', 'Пропылесосить', 30),
            dish('🧺', 'Постирать', 20),
          ]),
        ]),
        cat('Спорт', '🏋️', 'c4', [
          sec('Разминка', [ dish('🤸', 'Растяжка', 10) ]),
          sec('Тренировка', [
            dish('🏃', 'Кардио', 30),
            dish('💪', 'Силовая', 45),
          ]),
        ]),
        cat('Покупки', '🛒', 'c5', [
          sec('Продукты', [
            dish('🥛', 'Молоко', 1),
            dish('🍞', 'Хлеб', 1),
            dish('🥦', 'Овощи', 1),
          ]),
          sec('Бытовое', [ dish('🧴', 'Бытовая химия', 1) ]),
        ]),
        cat('Учёба', '📚', 'c6', [
          sec('Быстрое', [ dish('📖', 'Повторить конспект', 20) ]),
          sec('Основное', [
            dish('🎓', 'Лекция', 90),
            dish('✍️', 'Домашка', 60),
          ]),
        ]),
      ],
    };

    // Локальные фабрики для краткости
    function cat(name, emoji, color, sections) {
      return { id: uid(), name, emoji, color, sections };
    }
    function sec(name, items) { return { id: uid(), name, items }; }
    function dish(emoji, name, cost) { return { id: uid(), emoji, name, cost }; }
  },

  // --- Доступ к данным ---
  getCategory(id) { return this.state.categories.find((c) => c.id === id); },
  get unit() { return this.state.settings.unit; },
};

/* ----------------------------------------------------------------------- */
/* 3. ФОРМАТИРОВАНИЕ «ЦЕНЫ»                                                 */
/* ----------------------------------------------------------------------- */

// Перевод числа в человекочитаемую «цену» с учётом единицы измерения
function formatCost(value) {
  value = Math.round(value);
  if (DB.unit === 'points') return `${value} ⭐`;
  // Время в минутах → часы/минуты
  if (value < 60) return `${value} мин`;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
const unitLabel = () => (DB.unit === 'points' ? 'Баллы' : 'Время, мин');

// Метки и эмодзи приоритета
const PRIORITY = {
  fast:   { label: 'Быстрый',  emoji: '🔥' },
  normal: { label: 'Обычный',  emoji: '🕒' },
  lazy:   { label: 'Не срочно', emoji: '🧘' },
};

/* ----------------------------------------------------------------------- */
/* 4. НАВИГАЦИЯ (стек экранов)                                             */
/* ----------------------------------------------------------------------- */

// Конфигурация экранов: заголовок и то, верхнеуровневый ли это раздел
const SCREENS = {
  'tables':         { title: 'Мой заказ', top: true },
  'menu':           { title: 'Меню',      top: false },
  'cart':           { title: 'Заказ',     top: true },
  'history':        { title: 'История',   top: true },
  'history-detail': { title: 'Заказ',     top: false },
};

const nav = {
  stack: [{ screen: 'tables', params: {} }],

  current() { return this.stack[this.stack.length - 1]; },

  // Перейти на новый экран (добавить в стек)
  go(screen, params = {}) {
    this.stack.push({ screen, params });
    this.apply();
  },

  // Сбросить на верхнеуровневый раздел (для таб-бара)
  switchTop(screen) {
    this.stack = [{ screen, params: {} }];
    this.apply();
  },

  // Назад
  back() {
    if (this.stack.length > 1) { this.stack.pop(); this.apply(); }
  },

  // Применить текущее состояние стека: показать экран, обновить кнопки/шапку
  apply() {
    const { screen, params } = this.current();

    // Показ нужного экрана
    $$('.screen').forEach((s) => s.classList.toggle('is-active', s.dataset.screen === screen));
    window.scrollTo(0, 0);

    // Заголовок и активная вкладка
    const cfg = SCREENS[screen];
    $('#topbarTitle').textContent = params.title || cfg.title;
    $$('.tabbar__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === screen));

    // Кнопка «Назад» — если есть куда возвращаться
    if (this.stack.length > 1) tg.showBackButton(); else tg.hideBackButton();

    // Цвет шапки: яркий на верхнем уровне, спокойный внутри
    tg.setHeaderColor(cfg.top ? 'secondary_bg_color' : 'bg_color');

    // FAB «добавить»: своя роль на экранах столов и меню
    const addFab = $('#addFab');
    if (screen === 'tables') { addFab.hidden = false; addFab.dataset.role = 'category'; }
    else if (screen === 'menu') { addFab.hidden = false; addFab.dataset.role = 'task'; }
    else { addFab.hidden = true; }

    // MainButton «Завершить заказ» — только на экране заказа и только если он не пуст
    updateMainButton();

    // Отрисовка содержимого
    renderCurrent();
  },
};

function renderCurrent() {
  const { screen, params } = nav.current();
  if (screen === 'tables') renderTables();
  else if (screen === 'menu') renderMenu(params.categoryId);
  else if (screen === 'cart') renderCart();
  else if (screen === 'history') renderHistory();
  else if (screen === 'history-detail') renderHistoryDetail(params.orderId);
}

/* ----------------------------------------------------------------------- */
/* 5. ЭКРАН СТОЛОВ (категории)                                            */
/* ----------------------------------------------------------------------- */

function renderTables() {
  const grid = $('#tilesGrid');
  const colorVar = (c) => `var(--${c || 'c2'})`;

  // Сколько активных задач из этой категории сейчас в заказе
  const countFor = (catId) =>
    DB.state.cart.categoryId === catId
      ? DB.state.cart.items.reduce((n, it) => n + it.qty, 0)
      : 0;

  grid.innerHTML = DB.state.categories.map((c) => {
    const n = countFor(c.id);
    return `
      <button class="tile" style="--tile:${colorVar(c.color)}" data-cat="${c.id}">
        ${n ? `<span class="tile__count">${n}</span>` : ''}
        <span class="tile__emoji">${esc(c.emoji)}</span>
        <span class="tile__name">${esc(c.name)}</span>
      </button>`;
  }).join('') + `
    <button class="tile tile--add" id="addCatTile">
      <span class="tile__emoji">＋</span>
      <span class="tile__name">Категория</span>
    </button>`;

  // Открытие меню категории
  $$('.tile[data-cat]', grid).forEach((tile) => {
    const id = tile.dataset.cat;
    tile.addEventListener('click', () => {
      tg.haptic('light');
      const c = DB.getCategory(id);
      nav.go('menu', { categoryId: id, title: `${c.emoji} ${c.name}` });
    });
    // Долгое нажатие / правый клик — редактирование категории
    attachLongPress(tile, () => openCategoryModal(id));
  });

  // Плитка «добавить категорию»
  $('#addCatTile').addEventListener('click', () => openCategoryModal(null));
}

/* ----------------------------------------------------------------------- */
/* 6. ЭКРАН МЕНЮ ЗАДАЧ                                                      */
/* ----------------------------------------------------------------------- */

function renderMenu(categoryId) {
  const c = DB.getCategory(categoryId);
  if (!c) { nav.switchTop('tables'); return; }

  const box = $('#menuSections');
  box.innerHTML = c.sections.map((s) => `
    <div class="menu__section">
      <div class="menu__section-head">
        <span class="menu__section-title">${esc(s.name)}</span>
        <span class="menu__section-line"></span>
      </div>
      ${s.items.map((it) => `
        <button class="dish" style="--accent:var(--${c.color})"
                data-dish="${it.id}" data-section="${s.id}">
          <span class="dish__emoji">${esc(it.emoji)}</span>
          <span class="dish__body">
            <span class="dish__name">${esc(it.name)}</span>
            <span class="dish__cost">${formatCost(it.cost)}</span>
          </span>
          <span class="dish__plus">＋</span>
        </button>`).join('')}
    </div>`).join('') || `<p class="screen__lead">В этом меню пока нет задач. Добавьте первую кнопкой ＋.</p>`;

  // Тап по карточке → окно модификаторов
  $$('.dish[data-dish]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const sec = c.sections.find((s) => s.id === el.dataset.section);
      const item = sec.items.find((i) => i.id === el.dataset.dish);
      openModifiers(c.id, item);
    });
  });

  updateCartFab();
}

/* ----------------------------------------------------------------------- */
/* 7. МОДИФИКАТОРЫ ЗАДАЧИ (добавление / редактирование строки заказа)       */
/* ----------------------------------------------------------------------- */

// Текущее состояние модального окна модификаторов
let modState = null;

// Открыть для добавления новой задачи из меню
function openModifiers(categoryId, item) {
  modState = {
    mode: 'add',
    categoryId,
    emoji: item.emoji,
    name: item.name,
    qty: 1,
    priority: 'normal',
    cost: item.cost,
    note: '',
  };
  fillModifiers();
  openModal('#modalModifiers');
}

// Открыть для редактирования уже добавленной строки заказа
function openModifiersEdit(lineId) {
  const line = DB.state.cart.items.find((i) => i.id === lineId);
  if (!line) return;
  modState = {
    mode: 'edit',
    lineId,
    emoji: line.emoji,
    name: line.name,
    qty: line.qty,
    priority: line.priority,
    cost: line.cost,
    note: line.note || '',
  };
  fillModifiers();
  openModal('#modalModifiers');
}

// Заполнить поля окна из modState
function fillModifiers() {
  $('#modEmoji').textContent = modState.emoji;
  $('#modTitle').textContent = modState.name;
  $('#qtyVal').textContent = modState.qty;
  $('#costInput').value = modState.cost;
  $('#costLabel').textContent = DB.unit === 'points' ? 'Баллы' : 'Оценочное время, мин';
  $('#noteInput').value = modState.note;
  $('#addToCartBtn').textContent = modState.mode === 'edit' ? 'Сохранить изменения' : 'Добавить в заказ';
  $$('#prioritySegments .segment').forEach((s) =>
    s.classList.toggle('is-active', s.dataset.priority === modState.priority));
}

function bindModifiers() {
  $('#qtyMinus').addEventListener('click', () => {
    modState.qty = Math.max(1, modState.qty - 1);
    $('#qtyVal').textContent = modState.qty;
  });
  $('#qtyPlus').addEventListener('click', () => {
    modState.qty += 1;
    $('#qtyVal').textContent = modState.qty;
  });
  $$('#prioritySegments .segment').forEach((s) => {
    s.addEventListener('click', () => {
      modState.priority = s.dataset.priority;
      $$('#prioritySegments .segment').forEach((x) => x.classList.remove('is-active'));
      s.classList.add('is-active');
    });
  });
  $('#addToCartBtn').addEventListener('click', commitModifiers);
}

// Сохранить результат окна модификаторов в корзину
function commitModifiers() {
  modState.cost = Math.max(0, parseInt($('#costInput').value, 10) || 0);
  modState.note = $('#noteInput').value.trim();

  if (modState.mode === 'add') {
    // Если в заказе есть задачи из другой категории — спросим о замене
    const cart = DB.state.cart;
    const proceed = () => {
      cart.categoryId = modState.categoryId;
      cart.items.push({
        id: uid(),
        emoji: modState.emoji,
        name: modState.name,
        qty: modState.qty,
        priority: modState.priority,
        cost: modState.cost,
        note: modState.note,
      });
      DB.save();
      closeModal('#modalModifiers');
      tg.haptic('success');
      toast('Добавлено в заказ');
      updateCartFab(); updateBadges(); updateMainButton();
    };

    if (cart.items.length && cart.categoryId && cart.categoryId !== modState.categoryId) {
      const prev = DB.getCategory(cart.categoryId);
      tg.confirm(`В заказе есть задачи из «${prev ? prev.name : '—'}». Очистить и начать заказ для новой категории?`, (ok) => {
        if (ok) { cart.items = []; proceed(); }
        else { closeModal('#modalModifiers'); }
      });
    } else {
      proceed();
    }
  } else {
    // Режим редактирования строки
    const line = DB.state.cart.items.find((i) => i.id === modState.lineId);
    if (line) {
      line.qty = modState.qty;
      line.priority = modState.priority;
      line.cost = modState.cost;
      line.note = modState.note;
      DB.save();
    }
    closeModal('#modalModifiers');
    tg.haptic('light');
    renderCart(); updateBadges(); updateMainButton();
  }
}

/* ----------------------------------------------------------------------- */
/* 8. ЭКРАН ЗАКАЗА (корзина)                                               */
/* ----------------------------------------------------------------------- */

function renderCart() {
  const cart = DB.state.cart;
  const list = $('#ticketList');
  const empty = $('#cartEmpty');
  const summary = $('#cartSummary');
  const completeBtn = $('#cartCompleteBtn');

  if (!cart.items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    summary.hidden = true;
    completeBtn.hidden = true;
    return;
  }
  empty.hidden = true;
  summary.hidden = false;

  // Запасная кнопка нужна только там, где нет нативной MainButton Telegram
  completeBtn.hidden = !!tg.api;

  list.innerHTML = cart.items.map((it) => ticketRowHTML(it)).join('');
  bindTicketRows(list, /* editable */ true);

  const total = cart.items.reduce((s, it) => s + it.cost * it.qty, 0);
  $('#cartTotal').textContent = formatCost(total);
}

// Разметка одной строки заказа (используется и в истории)
function ticketRowHTML(it, withDelete = true) {
  const pr = PRIORITY[it.priority] || PRIORITY.normal;
  const note = it.note ? `<div class="ticket-row__note">«${esc(it.note)}»</div>` : '';
  return `
    <div class="ticket-row" data-line="${it.id}">
      ${withDelete ? '<button class="ticket-row__delete">Удалить</button>' : ''}
      <div class="ticket-row__content">
        <span class="ticket-row__emoji">${esc(it.emoji)}</span>
        <div class="ticket-row__body">
          <div class="ticket-row__name">${esc(it.name)}</div>
          <div class="ticket-row__meta">
            <span class="tag">${pr.emoji} ${pr.label}</span>
            <span class="tag">⏱ ${formatCost(it.cost)}</span>
          </div>
          ${note}
        </div>
        ${it.qty > 1 ? `<span class="ticket-row__qty">×${it.qty}</span>` : ''}
      </div>
    </div>`;
}

// Навешиваем свайп-удаление и тап-редактирование на строки
function bindTicketRows(root, editable) {
  $$('.ticket-row', root).forEach((row) => {
    const content = $('.ticket-row__content', row);
    const delBtn = $('.ticket-row__delete', row);
    let startX = 0, dx = 0, dragging = false, moved = false;

    const onDown = (x) => { startX = x; dx = 0; dragging = true; moved = false; };
    const onMove = (x) => {
      if (!dragging) return;
      dx = x - startX;
      if (Math.abs(dx) > 6) moved = true;
      // Тянем только влево, ограничиваем шириной кнопки удаления
      let t = Math.min(0, Math.max(-84, dx + (row.classList.contains('is-open') ? -84 : 0)));
      content.style.transition = 'none';
      content.style.transform = `translateX(${t}px)`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      content.style.transition = '';
      content.style.transform = '';
      const open = row.classList.contains('is-open');
      // Решаем, открыть «удалить» или закрыть
      if (!open && dx < -42) { closeAllRows(); row.classList.add('is-open'); }
      else if (open && dx > 42) { row.classList.remove('is-open'); }
      else if (!moved) {
        // Это был тап: открытую строку закрываем, закрытую — редактируем
        if (open) row.classList.remove('is-open');
        else if (editable) openModifiersEdit(row.dataset.line);
      }
    };

    // Унифицированные указатели (мышь + тач)
    content.addEventListener('pointerdown', (e) => onDown(e.clientX));
    content.addEventListener('pointermove', (e) => onMove(e.clientX));
    content.addEventListener('pointerup', onUp);
    content.addEventListener('pointercancel', onUp);
    content.addEventListener('pointerleave', () => { if (dragging) onUp(); });

    if (delBtn) delBtn.addEventListener('click', () => removeCartLine(row.dataset.line));
  });
}

function closeAllRows() { $$('.ticket-row.is-open').forEach((r) => r.classList.remove('is-open')); }

function removeCartLine(lineId) {
  DB.state.cart.items = DB.state.cart.items.filter((i) => i.id !== lineId);
  if (!DB.state.cart.items.length) DB.state.cart.categoryId = null;
  DB.save();
  tg.haptic('warning');
  renderCart(); updateBadges(); updateMainButton();
}

// Завершить заказ: сохранить в историю и очистить корзину
function completeOrder() {
  const cart = DB.state.cart;
  if (!cart.items.length) return;
  const c = DB.getCategory(cart.categoryId);
  const total = cart.items.reduce((s, it) => s + it.cost * it.qty, 0);

  DB.state.history.unshift({
    id: uid(),
    date: new Date().toISOString(),
    categoryId: cart.categoryId,
    categoryName: c ? c.name : 'Без категории',
    categoryEmoji: c ? c.emoji : '🧾',
    categoryColor: c ? c.color : 'c2',
    items: cart.items.map((it) => ({ ...it, status: 'active' })),  // помечаем активными
    total,
    count: cart.items.reduce((n, it) => n + it.qty, 0),
  });

  cart.items = [];
  cart.categoryId = null;
  DB.save();
  tg.haptic('success');
  toast('Заказ завершён и сохранён в историю');
  nav.switchTop('history');
}

/* ----------------------------------------------------------------------- */
/* 9. ИСТОРИЯ ЗАКАЗОВ                                                       */
/* ----------------------------------------------------------------------- */

function renderHistory() {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  if (!DB.state.history.length) {
    list.innerHTML = ''; empty.hidden = false; return;
  }
  empty.hidden = true;

  list.innerHTML = DB.state.history.map((o) => {
    const d = new Date(o.date);
    const dateStr = d.toLocaleString('ru-RU',
      { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return `
      <button class="history-card" style="--accent:var(--${o.categoryColor || 'c2'})" data-order="${o.id}">
        <span class="history-card__emoji">${esc(o.categoryEmoji)}</span>
        <span class="history-card__body">
          <span class="history-card__title">${esc(o.categoryName)} · ${o.count} задач</span>
          <span class="history-card__date">${dateStr}</span>
        </span>
        <span class="history-card__total">${formatCost(o.total)}</span>
      </button>`;
  }).join('');

  $$('.history-card', list).forEach((el) => {
    el.addEventListener('click', () => {
      const o = DB.state.history.find((x) => x.id === el.dataset.order);
      nav.go('history-detail', { orderId: o.id, title: `${o.categoryEmoji} ${o.categoryName}` });
    });
  });
}

function renderHistoryDetail(orderId) {
  const o = DB.state.history.find((x) => x.id === orderId);
  if (!o) { nav.back(); return; }
  $('#historyDetailList').innerHTML = o.items.map((it) => ticketRowHTML(it, false)).join('');
  $('#historyDetailTotal').textContent = formatCost(o.total);

  // Повторить заказ — перенести задачи в текущую корзину
  $('#repeatOrderBtn').onclick = () => repeatOrder(o);
}

function repeatOrder(order) {
  const cart = DB.state.cart;
  const doRepeat = () => {
    cart.categoryId = order.categoryId;
    cart.items = order.items.map((it) => ({
      id: uid(),
      emoji: it.emoji, name: it.name, qty: it.qty,
      priority: it.priority, cost: it.cost, note: it.note || '',
    }));
    DB.save();
    tg.haptic('success');
    toast('Задачи добавлены в текущий заказ');
    nav.switchTop('cart');
  };

  if (cart.items.length) {
    tg.confirm('В текущем заказе уже есть задачи. Заменить их повтором этого заказа?', (ok) => { if (ok) doRepeat(); });
  } else {
    doRepeat();
  }
}

/* ----------------------------------------------------------------------- */
/* 10. МОДАЛКА КАТЕГОРИИ (создание / редактирование / удаление)            */
/* ----------------------------------------------------------------------- */

let catEditId = null;

function openCategoryModal(id) {
  catEditId = id;
  const isEdit = !!id;
  const c = isEdit ? DB.getCategory(id) : null;
  $('#catModalTitle').textContent = isEdit ? 'Редактировать категорию' : 'Новая категория';
  $('#catEmoji').value = isEdit ? c.emoji : '🍽️';
  $('#catName').value = isEdit ? c.name : '';
  $('#catDeleteBtn').hidden = !isEdit;
  openModal('#modalCategory');
}

function bindCategoryModal() {
  $('#catSaveBtn').addEventListener('click', () => {
    const emoji = $('#catEmoji').value.trim() || '🍽️';
    const name = $('#catName').value.trim();
    if (!name) { toast('Введите название'); return; }

    if (catEditId) {
      const c = DB.getCategory(catEditId);
      c.emoji = emoji; c.name = name;
    } else {
      // Подбираем цвет по кругу из палитры столов
      const colors = ['c1','c2','c3','c4','c5','c6','c7','c8'];
      const color = colors[DB.state.categories.length % colors.length];
      DB.state.categories.push({ id: uid(), name, emoji, color, sections: [
        { id: uid(), name: 'Задачи', items: [] },
      ]});
    }
    DB.save();
    closeModal('#modalCategory');
    tg.haptic('success');
    renderTables();
  });

  $('#catDeleteBtn').addEventListener('click', () => {
    if (!catEditId) return;
    tg.confirm('Удалить категорию вместе с её меню?', (ok) => {
      if (!ok) return;
      DB.state.categories = DB.state.categories.filter((c) => c.id !== catEditId);
      if (DB.state.cart.categoryId === catEditId) { DB.state.cart.items = []; DB.state.cart.categoryId = null; }
      DB.save();
      closeModal('#modalCategory');
      tg.haptic('warning');
      renderTables(); updateBadges(); updateMainButton();
    });
  });
}

/* ----------------------------------------------------------------------- */
/* 11. МОДАЛКА НОВОЙ ЗАДАЧИ В МЕНЮ                                          */
/* ----------------------------------------------------------------------- */

function openTaskModal() {
  const { params } = nav.current();
  const c = DB.getCategory(params.categoryId);
  if (!c) return;

  $('#taskEmoji').value = '✅';
  $('#taskName').value = '';
  $('#taskCost').value = DB.unit === 'points' ? 1 : 10;
  $('#taskCostLabel').textContent = DB.unit === 'points' ? 'Баллы по умолчанию' : 'Время по умолчанию, мин';
  $('#taskNewSection').value = '';

  // Выпадающий список существующих разделов меню
  $('#taskSection').innerHTML = c.sections.map((s) =>
    `<option value="${s.id}">${esc(s.name)}</option>`).join('')
    || '<option value="">— нет разделов —</option>';

  openModal('#modalTask');
}

function bindTaskModal() {
  $('#taskSaveBtn').addEventListener('click', () => {
    const { params } = nav.current();
    const c = DB.getCategory(params.categoryId);
    if (!c) return;

    const emoji = $('#taskEmoji').value.trim() || '✅';
    const name = $('#taskName').value.trim();
    const cost = Math.max(0, parseInt($('#taskCost').value, 10) || 0);
    if (!name) { toast('Введите название задачи'); return; }

    // Раздел: либо новый по введённому названию, либо выбранный из списка
    const newSecName = $('#taskNewSection').value.trim();
    let section;
    if (newSecName) {
      section = { id: uid(), name: newSecName, items: [] };
      c.sections.push(section);
    } else {
      section = c.sections.find((s) => s.id === $('#taskSection').value);
      if (!section) { section = { id: uid(), name: 'Задачи', items: [] }; c.sections.push(section); }
    }

    section.items.push({ id: uid(), emoji, name, cost });
    DB.save();
    closeModal('#modalTask');
    tg.haptic('success');
    renderMenu(c.id);
  });
}

/* ----------------------------------------------------------------------- */
/* 12. НАСТРОЙКИ + ЭКСПОРТ / ИМПОРТ                                         */
/* ----------------------------------------------------------------------- */

function openSettings() {
  $$('#unitSegments .segment').forEach((s) =>
    s.classList.toggle('is-active', s.dataset.unit === DB.unit));
  openModal('#modalSettings');
}

function bindSettings() {
  // Переключатель единицы измерения
  $$('#unitSegments .segment').forEach((s) => {
    s.addEventListener('click', () => {
      DB.state.settings.unit = s.dataset.unit;
      DB.save();
      $$('#unitSegments .segment').forEach((x) => x.classList.remove('is-active'));
      s.classList.add('is-active');
      renderCurrent();
    });
  });

  // Экспорт всей базы в JSON-файл
  $('#exportBtn').addEventListener('click', () => {
    const data = JSON.stringify(DB.state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `moy-zakaz-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Файл выгружен');
  });

  // Импорт базы из JSON-файла
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.categories)) throw new Error('bad');
        DB.state = data;
        // Гарантируем обязательные поля
        DB.state.settings = DB.state.settings || { unit: 'time' };
        DB.state.cart = DB.state.cart || { categoryId: null, items: [] };
        DB.state.history = DB.state.history || [];
        DB.save();
        closeModal('#modalSettings');
        tg.haptic('success');
        toast('База импортирована');
        nav.switchTop('tables');
      } catch (err) {
        toast('Не удалось прочитать файл');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Полный сброс
  $('#resetBtn').addEventListener('click', () => {
    tg.confirm('Сбросить все данные к стандартному набору? Текущие категории, заказ и историю нельзя будет вернуть.', (ok) => {
      if (!ok) return;
      DB.reset();
      closeModal('#modalSettings');
      tg.haptic('warning');
      nav.switchTop('tables');
      updateBadges(); updateMainButton();
    });
  });
}

/* ----------------------------------------------------------------------- */
/* 13. ОБЩИЕ ЭЛЕМЕНТЫ: модалки, тосты, бейджи, MainButton, FAB             */
/* ----------------------------------------------------------------------- */

function openModal(sel) {
  closeAllRows();
  $(sel).hidden = false;
}
function closeModal(sel) { $(sel).hidden = true; }

// Любая модалка закрывается тапом по затемнению
function bindModalBackdrops() {
  $$('.modal').forEach((m) => {
    $('.modal__backdrop', m).addEventListener('click', () => { m.hidden = true; });
  });
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// Бейджи количества задач в заказе (таб-бар)
function updateBadges() {
  const n = DB.state.cart.items.reduce((s, it) => s + it.qty, 0);
  const badge = $('#tabCartBadge');
  if (n) { badge.hidden = false; badge.textContent = n; } else { badge.hidden = true; }
}

// Плавающая кнопка «Заказ» на экране меню
function updateCartFab() {
  const fab = $('#cartFab');
  const onMenu = nav.current().screen === 'menu';
  const n = DB.state.cart.items.reduce((s, it) => s + it.qty, 0);
  if (onMenu && n) {
    fab.hidden = false;
    $('#cartFabBadge').textContent = n;
  } else {
    fab.hidden = true;
  }
}

// MainButton «Завершить заказ» — показываем только на экране заказа
function updateMainButton() {
  const onCart = nav.current().screen === 'cart';
  const n = DB.state.cart.items.length;
  if (onCart && n) tg.mainButton('Завершить заказ', completeOrder);
  else tg.hideMainButton();
  updateCartFab();
  updateBadges();
}

/* ----------------------------------------------------------------------- */
/* 14. ДОЛГОЕ НАЖАТИЕ (универсальный помощник)                             */
/* ----------------------------------------------------------------------- */

function attachLongPress(el, cb, ms = 500) {
  let timer = null, suppressClick = false;
  el.addEventListener('touchstart', () => {
    suppressClick = false;
    timer = setTimeout(() => { suppressClick = true; tg.haptic('medium'); cb(); }, ms);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  // Если сработало долгое нажатие — гасим синтетический click (фаза перехвата,
  // раньше обычного обработчика навигации), чтобы не открыть меню заодно.
  el.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
  // Десктоп: правый клик для отладки
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cb(); });
}

/* ----------------------------------------------------------------------- */
/* 15. ИНИЦИАЛИЗАЦИЯ                                                        */
/* ----------------------------------------------------------------------- */

function init() {
  DB.load();
  tg.init();

  // Кнопка «Назад» Telegram
  tg.onBack(() => nav.back());

  // Нижняя навигация
  $$('.tabbar__btn').forEach((b) =>
    b.addEventListener('click', () => { tg.haptic('light'); nav.switchTop(b.dataset.nav); }));

  // FAB «добавить»: категория или задача в зависимости от экрана
  $('#addFab').addEventListener('click', () => {
    const role = $('#addFab').dataset.role;
    if (role === 'category') openCategoryModal(null);
    else if (role === 'task') openTaskModal();
  });

  // Плавающая кнопка «Заказ» с экрана меню
  $('#cartFab').addEventListener('click', () => nav.switchTop('cart'));

  // Кнопки на пустой корзине
  $('#cartEmptyBack').addEventListener('click', () => nav.switchTop('tables'));

  // Запасная кнопка завершения заказа (режим браузера без MainButton)
  $('#cartCompleteBtn').addEventListener('click', completeOrder);

  // Шестерёнка настроек
  $('#settingsBtn').addEventListener('click', openSettings);

  // Привязка обработчиков модалок (один раз)
  bindModifiers();
  bindCategoryModal();
  bindTaskModal();
  bindSettings();
  bindModalBackdrops();

  // Первый показ
  nav.apply();
  updateBadges();
}

// Старт после загрузки DOM
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', init);
else
  init();
