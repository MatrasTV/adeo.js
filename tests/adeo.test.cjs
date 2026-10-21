const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

// Открываем внутренние функции только в тестовой копии, не меняя рабочий скрипт.
const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8').replace(
    '    init();',
    `    globalThis.api = { init, getPreviousMonthDate, fillFieldOnce, setCheckboxOnce,
        updateTextStyle, copyIntersections, getSupplierKey, openNewPrice, copyText,
        showSrokiModal, setFileAcceptAttribute };`
);

function setup(pathname = '/неизвестная-страница') {
    const copied = [];
    const alerts = [];
    const context = vm.createContext({
        document: { querySelectorAll: () => [], querySelector: () => null },
        window: { location: { pathname, href: '' } },
        navigator: { clipboard: { writeText: async text => copied.push(text) } },
        Event: class { constructor(type) { this.type = type; } },
        console: { log() {}, error() {} },
        alert: text => alerts.push(text),
        AbortController, setTimeout, clearTimeout
    });
    vm.runInContext(source, context);
    return { context, api: context.api, copied, alerts };
}

test('Дата предыдущего месяца: конец месяца, високосный год и переход года', () => {
    const { api } = setup();
    for (const [date, expected] of [
        [new Date(2026, 2, 31), '2026-02-28'],
        [new Date(2024, 2, 31), '2024-02-29'],
        [new Date(2026, 0, 15), '2025-12-15'],
        [new Date(2026, 9, 21), '2026-09-21']
    ]) assert.equal(api.getPreviousMonthDate(date), expected);
});

test('Начальное значение поля не затирает ручную правку', () => {
    const { api, context } = setup();
    const events = [];
    const input = { value: '', dispatchEvent: event => events.push(event.type) };
    context.document.querySelectorAll = () => [input];
    api.fillFieldOnce('input', '5');
    assert.equal(input.value, '5');
    input.value = '9';
    api.fillFieldOnce('input', '5');
    assert.equal(input.value, '9');
    assert.deepEqual(events, ['input', 'change']);
});

test('Флажки не переключаются повторно при обновлении страницы', () => {
    const { api } = setup();
    let clicks = 0;
    const input = {
        checked: true, closest: () => null, parentElement: null,
        click() { this.checked = !this.checked; clicks++; }
    };
    api.setCheckboxOnce(input, false);
    api.setCheckboxOnce(input, false);
    assert.equal(input.checked, false);
    assert.equal(clicks, 1);
    input.checked = true;
    api.setCheckboxOnce(input, false);
    assert.equal(input.checked, true);
    const alreadyChecked = { checked: true };
    api.setCheckboxOnce(alreadyChecked, true);
});

test('Флажок iCheck переключается через вспомогательный элемент', () => {
    const { api } = setup();
    const input = { checked: true, closest: () => null };
    input.parentElement = { querySelector: () => ({ click: () => { input.checked = false; } }) };
    api.setCheckboxOnce(input, false);
    assert.equal(input.checked, false);
});

test('Оформление всех статусов и сброс цвета для неизвестного статуса', () => {
    const { api } = setup();
    const element = { style: {} };
    for (const [text, color] of [
        ['УЖЕ ИДЕТ ИМПОРТ', 'red'], ['Задание в очереди', '#CC9933'],
        ['Импорт окончен', 'green'], ['Нет задания', '']
    ]) {
        element.textContent = text;
        api.updateTextStyle(element);
        assert.equal(element.style.color, color);
        assert.equal(element.style.fontWeight, 'bold');
    }
});

test('Копирование пересечений различает p_* и cp_* и сохраняет 12 столбцов', async () => {
    const { api, copied } = setup();
    const row = {
        querySelector(selector) {
            const values = {
                'td[aria-describedby$="_pn_clean"]': ' ABC ',
                'td[aria-describedby$="_p_cost_eval"]': '100',
                'td[aria-describedby$="_cp_cost_eval"]': '200',
                'td[aria-describedby$="_p_pn_price_desc"]': 'Описание\nс переносом'
            };
            return selector in values ? { textContent: values[selector] } : null;
        }
    };
    const header = { closest: () => ({ querySelector: () => ({ querySelectorAll: () => [row] }) }) };
    api.copyIntersections(header);
    await Promise.resolve();
    const cells = copied[0].split('\t');
    assert.equal(cells.length, 12);
    assert.equal(cells[0], 'ABC');
    assert.equal(cells[2], '');
    assert.equal(cells[4], 'Описание с переносом');
    assert.equal(cells[5], '100');
    assert.equal(cells[9], '200');
    assert.equal(cells[11], '');
});

test('Переход к новому прайсу сохраняет поставщика и версию', () => {
    const { api, context } = setup('/admin/supplier/price/compare/43068/3/');
    api.openNewPrice();
    assert.equal(context.window.location.href, '/admin/supplier/price/comparemode/43068/3');
    context.window.location.pathname = '/admin/supplier/price/compare/43068';
    context.window.location.href = '';
    api.openNewPrice();
    assert.equal(context.window.location.href, '');
});

test('Ошибка буфера обмена отображается пользователю', async () => {
    const { api, context, alerts } = setup();
    context.navigator.clipboard.writeText = async () => { throw new Error('Доступ запрещён'); };
    await api.copyText('Текст');
    assert.equal(alerts.length, 1);
});

test('Ошибки сервиса сроков снимают блокировку кнопки и не открывают окно', async () => {
    for (const response of [
        { ok: false, status: 500 },
        { ok: true, json: async () => [] },
        { ok: true, json: async () => null }
    ]) {
        const { api, context, alerts } = setup();
        context.fetch = async () => response;
        const button = { disabled: false };
        await api.showSrokiModal({ currentTarget: button });
        assert.equal(button.disabled, false);
        assert.equal(alerts.length, 1);
    }
});

test('Фильтр Excel применяется ко всем найденным полям', () => {
    const { api, context } = setup();
    const attributes = [];
    context.document.querySelectorAll = () => [
        { setAttribute: (...args) => attributes.push(args) },
        { setAttribute: (...args) => attributes.push(args) }
    ];
    api.setFileAcceptAttribute('input[type="file"]');
    assert.deepEqual(attributes, [['accept', '.xlsx, .xls'], ['accept', '.xlsx, .xls']]);
});

test('На каждой странице запускается только соответствующий модуль', () => {
    for (const [path, expected] of [
        ['/admin/admin_pricerelevance/list', 'input[name="outStart"]'],
        ['/admin/supplier/price/compare/43068/3', '.form-horizontal'],
        ['/admin/supplier/price/comparemode/43068/3', '.job-status']
    ]) {
        const { api, context } = setup(path);
        const selectors = [];
        const listeners = {};
        let observations = 0;
        let disconnections = 0;
        context.MutationObserver = class {
            observe() { observations++; }
            disconnect() { disconnections++; }
        };
        context.window.addEventListener = (name, callback) => { listeners[name] = callback; };
        context.document.querySelectorAll = selector => { selectors.push(selector); return []; };
        context.document.querySelector = selector => { selectors.push(selector); return null; };
        api.init();
        assert.equal(observations, 1);
        assert.ok(selectors.includes(expected));
        if (!path.includes('pricerelevance')) assert.ok(!selectors.includes('input[name="outStart"]'));
        if (!path.includes('comparemode')) assert.ok(!selectors.includes('.job-status'));
        listeners.pagehide();
        assert.equal(disconnections, 1);
        listeners.pageshow({ persisted: true });
        assert.equal(observations, 2);
    }
});
