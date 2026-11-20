const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8');

function setup(url = 'https://crm.adeo.pro/reports/marketability', answers = []) {
    const menus = [], opened = [], prompts = [], alerts = [];
    const window = { location: new URL(url), prompt: text => { prompts.push(text); return answers.shift() ?? null; }, alert: text => alerts.push(text) };
    window.top = window.self = window;
    const context = vm.createContext({ window, URL,
        GM_registerMenuCommand: (title, callback) => menus.push({ title, callback }),
        GM_openInTab: (url, options) => opened.push({ url, active: options.active }) });
    vm.runInContext(source.replace('    installLoadingProgress();',
        '    globalThis.api = { installQuickLinksMenu, parseQuickPriceReference }; installQuickLinksMenu(); return;'), context);
    return { api: context.api, context, window, menus, opened, prompts, alerts };
}

test('Меню содержит пять пунктов, открывает постоянные адреса в новых активных вкладках и не дублируется', () => {
    const state = setup();
    assert.equal(state.menus.length, 5);
    assert.equal(state.menus[4].title, 'Загрузка тестового прайса');
    assert.ok(!state.menus.some(menu => menu.title === 'Сравнение прайсов поставщика'));
    for (const menu of state.menus.slice(0, 4)) menu.callback();
    assert.deepEqual(state.opened, [
        { url: 'https://admin.adeo.pro/admin/admin_pricerelevance/list', active: true },
        { url: 'https://crm.adeo.pro/reports/marketability', active: true },
        { url: 'https://avatar.adeo.pro/istat.php', active: true },
        { url: 'https://crm.adeo.pro/supplier/supplier-list', active: true }
    ]);
    state.api.installQuickLinksMenu();
    assert.equal(state.menus.length, 5);
    assert.match(source, /@sandbox\s+raw/);
    assert.doesNotMatch(source.slice(0, source.indexOf('// ==/UserScript==')), /@grant\s+none/);
});

test('Страницы прайса берут текущего поставщика и номер; на других страницах работают ввод, отмена и проверка адреса', () => {
    const current = setup('https://admin.adeo.pro/admin/supplier/price/compare/43068/3');
    current.menus[4].callback();
    assert.equal(current.opened[0].url, 'https://admin.adeo.pro/admin/supplier/price/comparemode/43068/3');
    assert.equal(current.prompts.length, 0);
    current.window.location = new URL('https://admin.adeo.pro/admin/supplier/price/comparemode/123/2');
    current.menus[4].callback();
    assert.equal(current.opened[1].url, 'https://admin.adeo.pro/admin/supplier/price/comparemode/123/2');
    const other = setup(undefined, [' 123 / 2 ', 'https://admin.adeo.pro/admin/supplier/price/compare/456/1?view=all', 'https://evil.example/admin/supplier/price/compare/123/2', '0/1', null]);
    other.menus[4].callback(); other.menus[4].callback(); other.menus[4].callback(); other.menus[4].callback(); other.menus[4].callback();
    assert.deepEqual(other.opened.map(item => item.url), ['https://admin.adeo.pro/admin/supplier/price/comparemode/123/2', 'https://admin.adeo.pro/admin/supplier/price/comparemode/456/1']);
    assert.equal(other.alerts.length, 2);
});

test('Без Tampermonkey и во фреймах команды не регистрируются', () => {
    const missing = vm.createContext({ window: {} });
    assert.doesNotThrow(() => vm.runInContext(source.replace('    installLoadingProgress();',
        '    globalThis.installMenu = installQuickLinksMenu; installQuickLinksMenu(); return;'), missing));
    let registered = 0;
    missing.GM_registerMenuCommand = () => registered++;
    missing.GM_openInTab = () => {};
    missing.installMenu();
    assert.equal(registered, 5);
    const frame = vm.createContext({ window: { top: {}, self: {} },
        GM_registerMenuCommand() { throw new Error('Команда из фрейма'); }, GM_openInTab() {} });
    assert.doesNotThrow(() => vm.runInContext(source.replace('    installLoadingProgress();', '    installQuickLinksMenu(); return;'), frame));
});
