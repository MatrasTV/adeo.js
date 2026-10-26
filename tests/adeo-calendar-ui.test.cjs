const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Браузерные проверки доступны при установленном Playwright. */ }

async function fixture(path = '/supplier/supplier-list') {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Europe/Moscow' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    // Все обращения к домену подменены локальной страницей; настоящая CRM в тесте недоступна.
    await page.route('https://crm.adeo.pro/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<html lang="ru"><head><meta charset="UTF-8"></head><body><div id="q-app"><div class="q-dialog__inner"><main class="work-calendar"><div class="row">Отправка заказов CellaTEST</div></main></div></div></body></html>' }));
    await page.goto(`https://crm.adeo.pro${path}`);
    const dates = await page.evaluate(() => {
        const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const next = weekday => { const date = new Date(); date.setDate(date.getDate() + 1); while ((date.getDay() + 6) % 7 !== weekday) date.setDate(date.getDate() + 1); return day(date); };
        const add = (date, count) => { const result = new Date(`${date}T12:00:00`); result.setDate(result.getDate() + count); return day(result); };
        window.events = []; window.mutations = []; window.refreshed = 0;
        const native = {
            async list() { return { data: JSON.parse(JSON.stringify(window.events)) }; },
            async create(payload) {
                window.mutations.push({ type: 'create', payload: { ...payload } });
                window.events.push({ ...payload, id: 1000 + window.mutations.length, weeklyScheduleId: 2000 + window.mutations.length });
                if (window.failNextCreate) { window.failNextCreate = false; throw new Error('Ответ сервера потерян'); }
                return { data: { id: 1000 + window.mutations.length } };
            },
            async remove(id, future) {
                window.mutations.push({ type: 'remove', id, future });
                const target = window.events.find(event => event.id === id);
                window.events = window.events.filter(event => future ? event.weeklyScheduleId !== target.weeklyScheduleId ||
                    event.ordersAcceptedAt < target.ordersAcceptedAt : event.id !== id);
                return { data: true };
            }
        };
        const main = document.querySelector('.work-calendar');
        window.calendarProxy = { supplier: { id: 127, cella: 'CellaTEST' }, storages: [{ nfile: 7, name: 'Основной' }],
            $API: { supplier: { schedule: native } }, $el: main, async loadSchedules() { window.refreshed++; } };
        document.querySelector('#q-app').__vue_app__ = { _container: { _vnode: { component: { subTree: { children: [
            { component: { type: { name: 'WorkCalendarQuasar' }, proxy: window.calendarProxy } }
        ] } } } } };
        return { friday: next(4), saturday: add(next(4), 1), source: next(1), target: add(next(1), 2), delivery: add(next(1), 3) };
    });
    await page.addScriptTag({ path: resolve(__dirname, '../adeo.user.js') });
    return { browser, page, dates, errors };
}

test('Мастер заполняет 20 записей, исправляет субботу и восстанавливается после потери ответа', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 90000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.getByLabel('Номер склада', { exact: true }).selectOption('7');
        await page.getByLabel('Начать с', { exact: true }).fill(dates.friday);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Понедельник', 'Вторник', 'Среда', 'Четверг']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        const deliveryDays = page.locator('.adeo-schedule-box').filter({ hasText: '3. Когда поставщик' });
        await deliveryDays.getByLabel('Суббота', { exact: true }).check();
        assert.equal(await deliveryDays.getByLabel('Воскресенье', { exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        for (let index = 1; index < 20; index++) await page.getByRole('button', { name: '＋ Добавить запись', exact: true }).click();
        const rows = page.locator('.adeo-schedule-template .adeo-schedule-row');
        assert.equal(await rows.count(), 20);
        for (let index = 0; index < 20; index++) {
            await rows.nth(index).getByLabel('Отправка заказа', { exact: true }).fill(`${String(index).padStart(2, '0')}:00`);
            await rows.nth(index).getByLabel('Интервал доставки', { exact: true }).selectOption('17');
        }
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-day').count(), 7);
        await page.getByText('Суббота: исправить время у 20 доставок', { exact: true }).waitFor();
        await page.getByLabel('Общий интервал для выбранных записей', { exact: true }).selectOption('15');
        await page.getByRole('button', { name: 'Применить к выбранным', exact: true }).click();
        assert.match(await page.locator('[data-schedule-summary]').textContent(), /Записей: 20.*Замечаний: 0/);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        if (process.env.ADEO_CALENDAR_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_CALENDAR_SCREENSHOT });
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.evaluate(() => { window.failNextCreate = true; });
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Сохранение остановлено', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 1);
        await page.getByRole('button', { name: 'Проверить результат и продолжить', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const saved = await page.evaluate(() => ({ mutations: window.mutations, events: window.events, refreshed: window.refreshed }));
        assert.equal(saved.mutations.length, 20);
        assert.equal(saved.refreshed, 1);
        assert.ok(saved.events.every(event => event.nfile === 7 && event.repeatWeekly && event.orderDeliveryIntervalStart.startsWith(`${dates.saturday}T15:00`) && event.orderDeliveryIntervalEnd.startsWith(`${dates.saturday}T16:00`)));
        assert.equal(new Set(saved.events.map(event => event.ordersAcceptedAt)).size, 20);
        assert.deepEqual(errors, []);
        await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-overlay').count(), 0);
    } finally { await browser.close(); }
});

async function seedCopy(page, dates) {
    await page.evaluate(({ source, target }) => {
        const entry = (id, date, time, nfile, weekly = true) => ({ id, supplierId: 127, nfile,
            weeklyScheduleId: weekly ? id + 100 : 0, ordersAcceptedAt: `${date}T${time}:00+03:00`,
            orderDeliveryIntervalStart: null, orderDeliveryIntervalEnd: null });
        window.events = [entry(1, source, '09:00', 7), entry(2, source, '12:00', null), entry(3, source, '13:00', 8, false),
            entry(4, target, '10:00', 7), entry(5, target, '14:00', null), entry(6, target, '11:00', 9)];
    }, dates);
    await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
    await page.getByRole('button', { name: 'Скопировать день' }).click();
    await page.getByLabel('Из какого дня', { exact: true }).fill(dates.source);
    await page.getByLabel('В какой день', { exact: true }).fill(dates.target);
    await page.getByRole('button', { name: 'Подготовить копию', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить всё', exact: true }).waitFor();
}

test('Копирование берёт только еженедельные записи и заменяет только исходные склады', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        assert.equal(await page.locator('.adeo-schedule-row').count(), 2);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const data = await page.evaluate(() => ({ events: window.events, mutations: window.mutations }));
        assert.deepEqual(data.mutations.filter(item => item.type === 'remove').map(item => [item.id, item.future]), [[4, true], [5, true]]);
        const created = data.mutations.filter(item => item.type === 'create').map(item => item.payload);
        assert.equal(created.length, 2);
        assert.deepEqual(created.map(item => item.nfile), [7, null]);
        assert.ok(created.every(item => item.ordersAcceptedAt.startsWith(dates.target) && item.repeatWeekly && item.orderDeliveryIntervalStart === null));
        assert.ok([1, 2, 3, 6].every(id => data.events.some(event => event.id === id)));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Изменение расписания другим пользователем требует повторной проверки конфликтов', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        await page.evaluate(() => { window.events[3].ordersAcceptedAt = window.events[3].ordersAcceptedAt.replace('10:00', '10:30'); });
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'За время проверки расписание в CRM изменилось' }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.equal(await page.getByLabel('Действие', { exact: true }).inputValue(), '');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Кнопка появляется после перехода внутри CRM без перезагрузки страницы', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, errors } = await fixture('/dashboard');
    try {
        assert.equal(await page.getByRole('button', { name: 'Мастер расписания', exact: true }).count(), 0);
        await page.evaluate(() => { history.pushState(null, '', '/supplier/supplier-list'); document.querySelector('.work-calendar .row').append(document.createElement('span')); });
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).waitFor();
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Копирование дня в черновике спрашивает действие, сдвигает доставку и сохраняет независимость дней', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.getByLabel('Начать с', { exact: true }).fill(dates.friday);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Понедельник', 'Вторник', 'Среда', 'Четверг']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        const friday = page.locator('.adeo-schedule-day').nth(4);
        const saturday = page.locator('.adeo-schedule-day').nth(5);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        const deliveryDates = await page.locator('.adeo-schedule-row input[type="date"]').evaluateAll(inputs => inputs.map(input => input.value));
        const dateDifference = (new Date(`${deliveryDates[1]}T12:00:00Z`) - new Date(`${deliveryDates[0]}T12:00:00Z`)) / 86400000;
        assert.equal(dateDifference, 1);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Отмена', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Заменить', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        await friday.locator('summary').click();
        await friday.getByLabel('Отправка заказа', { exact: true }).fill('10:00');
        await friday.locator('summary').click();
        assert.match(await saturday.locator('summary').textContent(), /^09:00/);
        assert.match(await friday.locator('summary').textContent(), /^10:00/);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Добавить', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 2);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
