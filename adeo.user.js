// ==UserScript==
// @name         ADEO — инструменты работы с прайсами
// @namespace    admin.adeo.pro
// @version      3.1.2
// @description  Анализ продаваемости, пересечения, сроки, копирование и оформление статусов импорта
// @author       MatrasTV
// @icon         https://github.com/MatrasTV.png?size=128
// @homepageURL  https://github.com/MatrasTV/adeo.js
// @source       https://github.com/MatrasTV/adeo.js.git
// @supportURL   https://github.com/MatrasTV/adeo.js/issues
// @downloadURL  https://github.com/MatrasTV/adeo.js/releases/latest/download/adeo.user.js
// @updateURL    https://github.com/MatrasTV/adeo.js/releases/latest/download/adeo.user.js
// @match        https://admin.adeo.pro/admin/admin_pricerelevance/list*
// @match        https://admin.adeo.pro/admin/supplier/price/compare/*
// @match        https://admin.adeo.pro/admin/supplier/price/comparemode/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SROKI_URL = 'https://192.168.3.19:6001/sroki';
    const PAGE_SIZES = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 100000];
    const initializedFields = new WeakSet();
    const filteredRowDisplays = new WeakMap();
    const supplierRowHeights = new WeakMap();
    const copyFeedback = new WeakMap();
    const priceDifferenceValues = new WeakMap();
    let hideReg = true;

    // Следим за появлением элементов и обновлением текста без постоянного опроса.
    function observePage(update) {
        const observer = new MutationObserver(update);
        const config = { childList: true, subtree: true, characterData: true };
        observer.observe(document.body, config);
        update();
        window.addEventListener('pagehide', () => observer.disconnect());
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            observer.observe(document.body, config);
            update();
        });
    }

    function setFileAcceptAttribute(selector) {
        document.querySelectorAll(selector).forEach(input => {
            input.setAttribute('accept', '.xlsx, .xls');
        });
    }

    // Начальные значения задаём однократно, чтобы сохранить последующие правки пользователя.
    function fillFieldOnce(selector, value) {
        document.querySelectorAll(selector).forEach(input => {
            if (initializedFields.has(input)) return;
            input.value = value;
            initializedFields.add(input);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    // Переключаем флажок только при несовпадении состояния, учитывая оформление iCheck.
    function setCheckboxOnce(input, checked, silent = false) {
        if (!input || initializedFields.has(input)) return;
        initializedFields.add(input);
        if (silent) {
            // Начальное состояние не должно запускать пересоздание таблицы через change/iCheck.
            input.checked = checked;
            const wrapper = input.closest('.icheckbox_minimal');
            wrapper?.classList.toggle('checked', checked);
            wrapper?.setAttribute('aria-checked', String(checked));
            return;
        }
        if (input.checked === checked) return;
        const wrapper = input.closest('.icheckbox_minimal');
        const helper = input.parentElement?.querySelector('.iCheck-helper');
        if (helper) helper.click();
        else if (wrapper) wrapper.click();
        else input.click();
        if (input.checked !== checked) {
            input.checked = checked;
            wrapper?.classList.toggle('checked', checked);
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Используем местную дату и ограничиваем день последним днём предыдущего месяца.
    function getPreviousMonthDate(now = new Date()) {
        const date = new Date(now.getFullYear(), now.getMonth(), 1);
        date.setMonth(date.getMonth() - 1);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(now.getDate(), lastDay));
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function initPriceRelevance() {
        observePage(() => {
            setFileAcceptAttribute('input[type="file"][name="price"]');
            fillFieldOnce('input[name="outStart"]', '5');
            fillFieldOnce('input[name="start_date"]', getPreviousMonthDate());
            setCheckboxOnce(document.querySelector('input[name="orders_avg_cost"]'), false);
            setCheckboxOnce(document.querySelector('input[name="orders_max_cost"]'), false);
        });
    }

    function updateTextStyle(element) {
        const text = element.textContent.trim().toLowerCase();
        element.style.fontWeight = 'bold';
        if (text.includes('уже идет импорт')) element.style.color = 'red';
        else if (text.includes('задание в очереди')) element.style.color = '#CC9933';
        else if (text.includes('импорт окончен')) element.style.color = 'green';
        else element.style.color = '';
    }

    function initCompareMode() {
        observePage(() => {
            document.querySelectorAll('.job-status').forEach(updateTextStyle);
            setFileAcceptAttribute('input[type="file"][name="upfile"][id="pricefile"]');
        });
    }

    function getCellText(row, column, partial = false) {
        const operator = partial ? '*=' : '=';
        return row.querySelector(`td[aria-describedby${operator}"${column}"]`)?.textContent.trim() ?? '';
    }

    function getSupplierKey(row) {
        return `${getCellText(row, 'supplier_price_unique_supplier_cella')}/${getCellText(row, 'supplier_price_unique_n_file')}`;
    }

    function getSupplierRows() {
        return Array.from(document.querySelectorAll('tr.jqgrow')).filter(row =>
            row.querySelector('td[aria-describedby="supplier_price_unique_supplier_cella"]') &&
            row.querySelector('td[aria-describedby="supplier_price_unique_n_file"]')
        );
    }

    async function copyText(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            if (button) showCopyFeedback(button);
            console.log('[ADEO] Данные скопированы в буфер обмена');
        } catch (error) {
            console.error('[ADEO] Ошибка копирования:', error);
            alert('Не удалось скопировать данные. Проверьте разрешение браузера на доступ к буферу обмена.');
        }
    }

    function showCopyFeedback(button) {
        const previous = copyFeedback.get(button);
        if (previous) clearTimeout(previous.timer);
        const originalText = previous?.originalText ?? button.textContent;
        const originalWidth = previous?.originalWidth ?? button.style.minWidth;
        button.style.minWidth = `${button.getBoundingClientRect().width}px`;
        button.textContent = 'Скопировано ✓';
        button.classList.add('adeo-copied');
        const timer = setTimeout(() => {
            button.textContent = originalText;
            button.style.minWidth = originalWidth;
            button.classList.remove('adeo-copied');
            copyFeedback.delete(button);
        }, 1800);
        copyFeedback.set(button, { originalText, originalWidth, timer });
    }

    function createButton(text, onClick, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.style.cursor = 'pointer';
        button.addEventListener('click', onClick);
        return button;
    }

    function renderSrokiModal(keys, dictionary) {
        if (document.querySelector('.adeo-sroki-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'adeo-sroki-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999'
        });
        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Сроки');
        Object.assign(modal.style, {
            position: 'relative', backgroundColor: '#fff', color: '#333', padding: '20px',
            borderRadius: '6px', maxWidth: '600px', width: '90%', maxHeight: '90vh',
            overflowY: 'auto', boxSizing: 'border-box'
        });
        const title = document.createElement('h2');
        title.textContent = 'Сроки';
        const table = document.createElement('table');
        Object.assign(table.style, { borderCollapse: 'collapse', width: '100%' });
        const header = table.createTHead().insertRow();
        ['Cella/Склад', 'Срок'].forEach(text => {
            const cell = document.createElement('th');
            cell.textContent = text;
            header.appendChild(cell);
        });
        const body = table.createTBody();
        keys.forEach(key => {
            const row = body.insertRow();
            row.insertCell().textContent = key;
            row.insertCell().textContent = dictionary[key] ?? '—';
        });
        table.querySelectorAll('th, td').forEach(cell => {
            Object.assign(cell.style, { border: '1px solid #ccc', padding: '8px' });
        });
        const previousFocus = document.activeElement;
        function closeModal() {
            overlay.remove();
            document.removeEventListener('keydown', handleEscape);
            previousFocus?.focus();
        }
        function handleEscape(event) {
            if (event.key === 'Escape') closeModal();
        }
        const closeButton = createButton('×', closeModal, 'adeo-close-modal');
        closeButton.setAttribute('aria-label', 'Закрыть');
        Object.assign(closeButton.style, { position: 'absolute', top: '10px', right: '10px', fontSize: '24px' });
        modal.append(title, table, closeButton);
        overlay.appendChild(modal);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeModal();
        });
        document.addEventListener('keydown', handleEscape);
        document.body.appendChild(overlay);
        closeButton.focus();
    }

    async function showSrokiModal(event) {
        const button = event.currentTarget;
        if (document.querySelector('.adeo-sroki-overlay') || button.disabled) return;
        button.disabled = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const keys = getSupplierRows().map(getSupplierKey);
            const response = await fetch(SROKI_URL, { signal: controller.signal });
            if (!response.ok) throw new Error(`Ошибка сервера: ${response.status}`);
            const dictionary = await response.json();
            if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
                throw new Error('Сервер вернул некорректный словарь сроков');
            }
            renderSrokiModal(keys, dictionary);
        } catch (error) {
            console.error('[ADEO] Не удалось загрузить сроки:', error);
            alert('Не удалось загрузить сроки с сервера. Подробности в консоли (F12 → Console).');
        } finally {
            clearTimeout(timeout);
            button.disabled = false;
        }
    }

    function openNewPrice() {
        const match = window.location.pathname.match(/^\/admin\/supplier\/price\/compare\/([^/]+)\/([^/]+)\/?$/);
        if (match) window.location.href = `/admin/supplier/price/comparemode/${match[1]}/${match[2]}`;
    }

    function installCompareStyles() {
        document.body.classList.add('adeo-compare');
        if (document.querySelector('#adeo-compare-styles')) return;
        const style = document.createElement('style');
        style.id = 'adeo-compare-styles';
        style.textContent = `
            .adeo-compare .adeo-controls { border: 1px solid #d8e0e8; border-radius: 6px; background: #f8fafc; margin-bottom: 14px; }
            .adeo-compare .adeo-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; }
            .adeo-compare .adeo-toolbar > button { box-sizing: border-box; height: 36px; padding: 0 14px; border: 1px solid #c4cdd7; border-radius: 4px; background: #fff; color: #26394d; font-size: 14px; white-space: nowrap; }
            .adeo-compare .adeo-toolbar > button:hover:not(:disabled) { background: #eaf1f8; border-color: #8faac4; }
            .adeo-compare .adeo-toolbar > button:focus-visible { outline: 2px solid #3274b5; outline-offset: 2px; }
            .adeo-compare .adeo-toolbar > button:disabled { opacity: .5; cursor: default; }
            .adeo-compare .adeo-toolbar .adeo-new-price { background: #28649a; border-color: #28649a; color: #fff; }
            .adeo-compare .adeo-toolbar .adeo-new-price:hover { background: #20527f; color: #fff; }
            .adeo-compare .adeo-toolbar .adeo-hide-reg[aria-checked="true"] { background: #e6f3ec; border-color: #91bfa5; color: #225b3b; }
            .adeo-compare .adeo-hide-reg::before { content: '○'; margin-right: 6px; }
            .adeo-compare .adeo-hide-reg[aria-checked="true"]::before { content: '✓'; }
            .adeo-compare .adeo-row-count { margin-left: auto; color: #4b5d70; font-size: 13px; }
            .adeo-compare .adeo-settings-body { margin: 0; padding: 0 12px 8px; border-top: 1px solid #d8e0e8; }
            .adeo-compare .adeo-settings-body[hidden] { display: none; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-row-even > td { background: #fff; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-row-odd > td { background: #f4f7fa; }
            .adeo-compare #supplier_price_unique > tbody > tr.jqgrow:hover > td { background: #eaf2fc; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-expanded > td { background: #dceafa; border-bottom-color: #9ebddc; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-expanded > td:first-child { box-shadow: inset 3px 0 #3274b5; }
            .adeo-compare .subgrid-data th.adeo-current-price { background: #e5effb; color: #244d7a; }
            .adeo-compare .subgrid-data th.adeo-compared-price { background: #e5f3ec; color: #245c42; }
            .adeo-compare .adeo-price-label { display: block; font-weight: bold; line-height: 18px; }
            .adeo-compare .subgrid-data th.adeo-current-price, .adeo-compare .subgrid-data th.adeo-compared-price { height: auto; padding: 3px 6px; }
            .adeo-compare .subgrid-data td.adeo-price-lower { background: #e7f4eb; color: #21613b; }
            .adeo-compare .subgrid-data td.adeo-price-higher { background: #fceceb; color: #963c36; }
            .adeo-compare .subgrid-data td.adeo-price-equal { color: #596575; }
            .adeo-compare button.adeo-copied { color: #21613b !important; background: #e7f4eb !important; }
            .adeo-compare .adeo-copy-button, .adeo-compare .adeo-copy-header-button { box-sizing: border-box; }
        `;
        document.head.appendChild(style);
    }

    function addToolbarButtons() {
        const target = document.querySelector('.form-horizontal');
        if (!target) return;
        installCompareStyles();
        if (target.querySelector('.adeo-toolbar[data-adeo-controls]')) return;
        const toolbar = target.querySelector('.adeo-toolbar') ?? document.createElement('div');
        toolbar.replaceChildren();
        toolbar.className = 'adeo-toolbar';
        toolbar.dataset.adeoControls = 'true';
        target.classList.add('adeo-controls');
        const settings = target.querySelector('fieldset');
        const settingsButton = createButton('Настройки', () => {
            settings.hidden = !settings.hidden;
            settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
        }, 'adeo-settings-toggle');
        settingsButton.disabled = !settings;
        if (settings) {
            settings.hidden = true;
            settings.classList.add('adeo-settings-body');
            if (!settings.id) settings.id = 'adeo-compare-settings';
            settingsButton.setAttribute('aria-controls', settings.id);
            settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
        }
        const regToggle = createButton('Скрывать Reg', () => {
            hideReg = !hideReg;
            regToggle.setAttribute('aria-checked', String(hideReg));
            filterSupplierRows();
            syncSupplierScrollHeight();
            updateSupplierPresentation();
        }, 'adeo-hide-reg');
        regToggle.setAttribute('role', 'switch');
        regToggle.setAttribute('aria-checked', String(hideReg));
        const counter = document.createElement('span');
        counter.className = 'adeo-row-count';
        counter.setAttribute('aria-live', 'polite');
        counter.title = 'Счётчик загруженных строк поставщиков';
        toolbar.append(
            createButton('Новый прайс', openNewPrice, 'adeo-new-price'),
            createButton('Сроки', showSrokiModal, 'adeo-sroki'),
            settingsButton,
            createButton('Свернуть все детализации', collapseAllDetails, 'adeo-collapse-all'),
            regToggle, counter
        );
        target.prepend(toolbar);
    }

    function isSupplierExpanded(row) {
        return Boolean(row.querySelector('.sgexpanded'));
    }

    function collapseAllDetails() {
        const table = document.querySelector('#supplier_price_unique');
        getSupplierRows().filter(isSupplierExpanded).forEach(row => {
            if (table && window.jQuery?.fn?.jqGrid) {
                window.jQuery(table).jqGrid('collapseSubGridRow', row.id);
            } else {
                row.querySelector('.sgexpanded')?.click();
            }
            const details = row.nextElementSibling;
            if (details && filteredRowDisplays.has(details)) {
                filteredRowDisplays.set(details, details.style.display);
            }
        });
        updateSupplierPresentation();
        syncSupplierScrollHeight();
    }

    function updateSupplierPresentation() {
        const rows = getSupplierRows();
        let visible = 0;
        rows.forEach(row => {
            const shown = row.style.display !== 'none';
            row.classList.toggle('adeo-row-odd', shown && visible % 2 === 1);
            row.classList.toggle('adeo-row-even', shown && visible % 2 === 0);
            row.classList.toggle('adeo-expanded', isSupplierExpanded(row));
            if (shown) visible++;
        });
        const hiddenReg = rows.filter(row => filteredRowDisplays.has(row) &&
            getCellText(row, 'supplier_price_unique_supplier_cella').includes('Reg')).length;
        const counter = document.querySelector('.adeo-row-count');
        const text = `Показано: ${visible} · Скрыто Reg: ${hiddenReg}`;
        if (counter && counter.textContent !== text) counter.textContent = text;
        const collapseButton = document.querySelector('.adeo-collapse-all');
        if (collapseButton) collapseButton.disabled = !rows.some(isSupplierExpanded);
    }

    function activateCheckboxWithText(text) {
        document.querySelectorAll('.checkbox label').forEach(label => {
            if (label.textContent.trim() === text) setCheckboxOnce(label.querySelector('input[type="checkbox"]'), true, true);
        });
    }

    function prepareInitialCompareRequest() {
        if (!/^\/admin\/supplier\/price\/compare\/[^/]+\/[^/]+\/?$/.test(window.location.pathname) ||
            document.readyState !== 'loading' || typeof XMLHttpRequest === 'undefined') return;
        const prototype = XMLHttpRequest.prototype;
        const originalOpen = prototype.open;
        const originalSend = prototype.send;
        const requests = new WeakMap();
        let pending = true;

        function openInitialRequest(method, url, ...args) {
            requests.delete(this);
            const result = originalOpen.call(this, method, url, ...args);
            const address = new URL(url, window.location.href);
            requests.set(this, { method: String(method).toUpperCase(), address });
            return result;
        }

        function sendInitialRequest(body) {
            const request = requests.get(this);
            if (pending && request?.method === 'POST' &&
                request.address.origin === window.location.origin &&
                request.address.pathname === window.location.pathname &&
                (body == null || typeof body === 'string' || body instanceof URLSearchParams)) {
                // Меняем только первый запрос основной таблицы, до его отправки на сервер.
                const params = new URLSearchParams(body ?? '');
                const input = document.querySelector('input[name="remains"]');
                params.set('settings[remains]', input?.value || 'on');
                body = params.toString();
                activateCheckboxWithText('Остаток');
                pending = false;
                // Последующие запросы полностью управляются действиями пользователя и самой панелью.
                if (prototype.open === openInitialRequest) prototype.open = originalOpen;
                if (prototype.send === sendInitialRequest) prototype.send = originalSend;
            }
            return originalSend.call(this, body);
        }

        prototype.open = openInitialRequest;
        prototype.send = sendInitialRequest;
    }

    function updateDropdownValues(dropdown) {
        if (dropdown.dataset.adeoUpdated) return;
        const selectedValue = dropdown.value;
        const values = PAGE_SIZES.includes(Number(selectedValue))
            ? PAGE_SIZES : [...PAGE_SIZES, Number(selectedValue)].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
        dropdown.replaceChildren();
        values.forEach(value => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            dropdown.appendChild(option);
        });
        dropdown.value = selectedValue;
        if (dropdown.selectedIndex < 0) dropdown.value = String(PAGE_SIZES[0]);
        dropdown.dataset.adeoUpdated = 'true';
    }

    function addCopyButtons() {
        getSupplierRows().forEach(row => {
            const fullname = row.querySelector('td[aria-describedby="supplier_price_unique_supplier_fullname"]');
            if (!fullname || row.querySelector('.adeo-copy-button')) return;
            const button = createButton('Скопировать в буфер', event => {
                // Данные читаем при нажатии, чтобы учитывать обновления таблицы.
                copyText(`${getSupplierKey(row)} (${getCellText(row, 'supplier_price_unique_cnt')}) ${getCellText(row, 'supplier_price_unique_prc_dup')}%`, event.currentTarget);
            }, 'adeo-copy-button');
            Object.assign(button.style, { marginLeft: '10px', float: 'right' });
            // В jqGrid действует white-space: pre: перенос в названии иначе опускает кнопку ниже.
            Object.assign(fullname.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
            fullname.appendChild(button);
        });
    }

    function filterSupplierRows() {
        getSupplierRows().forEach(row => {
            const hidden = hideReg && getCellText(row, 'supplier_price_unique_supplier_cella').includes('Reg');
            const targets = [row];
            // Развёрнутая детализация jqGrid находится в отдельной строке сразу после поставщика.
            if (row.nextElementSibling?.classList.contains('ui-subgrid')) targets.push(row.nextElementSibling);
            targets.forEach(target => {
                if (hidden) {
                    if (!filteredRowDisplays.has(target)) filteredRowDisplays.set(target, target.style.display);
                    target.style.display = 'none';
                } else if (filteredRowDisplays.has(target)) {
                    target.style.display = filteredRowDisplays.get(target);
                    filteredRowDisplays.delete(target);
                }
            });
        });
    }

    function syncSupplierScrollHeight() {
        const table = document.querySelector('#supplier_price_unique');
        const wrapper = table?.parentElement;
        if (!wrapper?.parentElement?.classList.contains('ui-jqgrid-bdiv')) return;
        const rows = getSupplierRows();
        const records = Number(table.p?.records);
        if (!table.p || (Number.isFinite(records) && rows.length >= records)) {
            // При полной загрузке резерв виртуальной прокрутки больше не нужен.
            wrapper.style.height = 'auto';
            return;
        }
        if (!Number.isFinite(records) || records <= 0) return;
        // До завершения загрузки сохраняем резерв для записей, которых ещё нет в DOM.
        const rowHeight = table.grid?.prevRowHeight || rows.find(row => row.offsetHeight > 0)?.offsetHeight ||
            supplierRowHeights.get(table) || parseFloat(wrapper.style.height) / records;
        if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
        supplierRowHeights.set(table, rowHeight);
        const hiddenCount = rows.filter(row => filteredRowDisplays.has(row)).length;
        wrapper.style.height = `${Math.max(0, records - hiddenCount) * rowHeight}px`;
    }

    function copyIntersections(header, button) {
        const table = header.closest('.subgrid-data')?.querySelector('table.ui-jqgrid-btable');
        if (!table) return;
        // Точные окончания имён исключают путаницу между колонками p_* и cp_*.
        const columns = ['pn_clean', 'cbg_group_code', '', 'p_pn_draft', 'p_pn_price_desc',
            'p_cost_eval', 'p_remains', 'cp_pn_draft', 'cp_pn_price_desc', 'cp_cost_eval',
            'cp_cost_eval_diff', 'cp_remains'];
        const lines = Array.from(table.querySelectorAll('tr.jqgrow'), row => columns.map(column => {
            if (!column) return '';
            const cell = row.querySelector(`td[aria-describedby$="_${column}"]`);
            const difference = cell && priceDifferenceValues.get(cell);
            const text = difference && cell.textContent === difference.formatted ? difference.raw : cell?.textContent ?? '';
            return text.trim().replace(/[\t\r\n]+/g, ' ');
        }).join('\t'));
        // Сохраняем завершающие табуляции: пустые последние столбцы нужны при вставке в Excel.
        copyText(lines.join('\n'), button);
    }

    function addCopyHeaderButtons() {
        document.querySelectorAll('th[role="columnheader"][colspan="3"]').forEach(header => {
            if (!header.closest('.subgrid-data') || !header.textContent.includes('Топ 500 позиций') ||
                header.querySelector('.adeo-copy-header-button')) return;
            const button = createButton('Копировать пересечения', event => copyIntersections(header, event.currentTarget), 'adeo-copy-header-button');
            Object.assign(button.style, { padding: '5px 10px', backgroundColor: 'white', border: '1px solid #333', borderRadius: '4px', color: '#333', fontWeight: 'bold' });
            header.replaceChildren(button);
        });
    }

    function stylePriceHeaders() {
        document.querySelectorAll('.subgrid-data th[role="columnheader"][colspan]').forEach(header => {
            const span = header.getAttribute('colspan');
            if (span !== '4' && span !== '5') return;
            header.classList.add(span === '4' ? 'adeo-current-price' : 'adeo-compared-price');
            if (header.querySelector('.adeo-price-label')) return;
            const label = document.createElement('span');
            label.className = 'adeo-price-label';
            label.textContent = span === '4' ? 'Текущий прайс' : 'Прайс сравнения';
            header.prepend(label);
        });
    }

    function formatPriceDifferences() {
        document.querySelectorAll('.subgrid-data td[aria-describedby$="_cp_cost_eval_diff"]').forEach(cell => {
            const raw = cell.textContent.trim();
            if (priceDifferenceValues.get(cell)?.formatted === cell.textContent) return;
            cell.classList.remove('adeo-price-lower', 'adeo-price-higher', 'adeo-price-equal');
            cell.removeAttribute('title');
            const numeric = raw.replace(/\s/g, '').replace(/%$/, '').replace('−', '-').replace(',', '.');
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) {
                priceDifferenceValues.delete(cell);
                return;
            }
            const value = Number(numeric);
            if (!Number.isFinite(value)) return;
            const amount = Math.abs(value).toLocaleString('ru-RU', { maximumFractionDigits: 20, useGrouping: false });
            const formatted = `${value < 0 ? '−' : value > 0 ? '+' : ''}${amount}%`;
            priceDifferenceValues.set(cell, { raw, formatted });
            cell.classList.add(value < 0 ? 'adeo-price-lower' : value > 0 ? 'adeo-price-higher' : 'adeo-price-equal');
            cell.title = value < 0 ? `Дешевле текущего прайса на ${amount}%` : value > 0 ? `Дороже текущего прайса на ${amount}%` : 'Цена совпадает с текущим прайсом';
            if (cell.textContent !== formatted) cell.textContent = formatted;
        });
    }

    function increaseWorkAreaHeight() {
        const workArea = document.querySelector('div.ui-jqgrid-bdiv');
        if (workArea && workArea.style.height !== '750px') workArea.style.height = '750px';
    }

    function initCompare() {
        observePage(() => {
            addToolbarButtons();
            activateCheckboxWithText('Остаток');
            document.querySelectorAll('select.ui-pg-selbox').forEach(updateDropdownValues);
            addCopyButtons();
            filterSupplierRows();
            syncSupplierScrollHeight();
            addCopyHeaderButtons();
            stylePriceHeaders();
            formatPriceDifferences();
            updateSupplierPresentation();
            increaseWorkAreaHeight();
        });
        // jqGrid меняет состояние раскрытия через классы, без добавления новых строк при повторном открытии.
        document.addEventListener('click', event => {
            if (event.target.closest?.('#supplier_price_unique .ui-sgcollapsed')) {
                setTimeout(updateSupplierPresentation, 0);
            }
        });
    }

    function init() {
        const path = window.location.pathname;
        if (/^\/admin\/admin_pricerelevance\/list\/?$/.test(path)) initPriceRelevance();
        else if (path.startsWith('/admin/supplier/price/compare/')) initCompare();
        else if (path.startsWith('/admin/supplier/price/comparemode/')) initCompareMode();
    }

    prepareInitialCompareRequest();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else {
        init();
    }
})();
