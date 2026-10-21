// ==UserScript==
// @name         ADEO — инструменты работы с прайсами
// @namespace    admin.adeo.pro
// @version      3.0.3
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
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SROKI_URL = 'https://192.168.3.19:6001/sroki';
    const PAGE_SIZES = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 100000];
    const initializedFields = new WeakSet();
    const filteredRowDisplays = new WeakMap();
    const supplierRowHeights = new WeakMap();

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
    function setCheckboxOnce(input, checked) {
        if (!input || initializedFields.has(input)) return;
        initializedFields.add(input);
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

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[ADEO] Данные скопированы в буфер обмена');
        } catch (error) {
            console.error('[ADEO] Ошибка копирования:', error);
            alert('Не удалось скопировать данные. Проверьте разрешение браузера на доступ к буферу обмена.');
        }
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

    function addToolbarButtons() {
        const target = document.querySelector('.form-horizontal');
        if (!target || target.querySelector('.adeo-toolbar')) return;
        const toolbar = document.createElement('div');
        toolbar.className = 'adeo-toolbar';
        // Сохраняем порядок кнопок исходного интерфейса.
        const buttons = [
            createButton('Новый прайс', openNewPrice, 'adeo-new-price'),
            createButton('Сроки', showSrokiModal, 'adeo-sroki')
        ];
        buttons.forEach(button => {
            Object.assign(button.style, { width: '200px', height: '50px', fontSize: '16px', marginRight: '10px' });
            toolbar.appendChild(button);
        });
        target.prepend(toolbar);
    }

    function activateCheckboxWithText(text) {
        document.querySelectorAll('.checkbox label').forEach(label => {
            if (label.textContent.trim() === text) setCheckboxOnce(label.querySelector('input[type="checkbox"]'), true);
        });
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
            const button = createButton('Скопировать в буфер', () => {
                // Данные читаем при нажатии, чтобы учитывать обновления таблицы.
                copyText(`${getSupplierKey(row)} (${getCellText(row, 'supplier_price_unique_cnt')}) ${getCellText(row, 'supplier_price_unique_prc_dup')}%`);
            }, 'adeo-copy-button');
            Object.assign(button.style, { marginLeft: '10px', float: 'right' });
            // В jqGrid действует white-space: pre: перенос в названии иначе опускает кнопку ниже.
            Object.assign(fullname.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
            fullname.appendChild(button);
        });
    }

    function filterSupplierRows() {
        getSupplierRows().forEach(row => {
            const hidden = getCellText(row, 'supplier_price_unique_supplier_cella').includes('Reg');
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

    function copyIntersections(header) {
        const table = header.closest('.subgrid-data')?.querySelector('table.ui-jqgrid-btable');
        if (!table) return;
        // Точные окончания имён исключают путаницу между колонками p_* и cp_*.
        const columns = ['pn_clean', 'cbg_group_code', '', 'p_pn_draft', 'p_pn_price_desc',
            'p_cost_eval', 'p_remains', 'cp_pn_draft', 'cp_pn_price_desc', 'cp_cost_eval',
            'cp_cost_eval_diff', 'cp_remains'];
        const lines = Array.from(table.querySelectorAll('tr.jqgrow'), row => columns.map(column =>
            column ? (row.querySelector(`td[aria-describedby$="_${column}"]`)?.textContent ?? '').trim().replace(/[\t\r\n]+/g, ' ') : ''
        ).join('\t'));
        // Сохраняем завершающие табуляции: пустые последние столбцы нужны при вставке в Excel.
        copyText(lines.join('\n'));
    }

    function addCopyHeaderButtons() {
        document.querySelectorAll('th[role="columnheader"][colspan="3"]').forEach(header => {
            if (!header.closest('.subgrid-data') || !header.textContent.includes('Топ 500 позиций') ||
                header.querySelector('.adeo-copy-header-button')) return;
            const button = createButton('Копировать пересечения', () => copyIntersections(header), 'adeo-copy-header-button');
            Object.assign(button.style, { padding: '5px 10px', backgroundColor: 'white', border: '1px solid #333', borderRadius: '4px', color: '#333', fontWeight: 'bold' });
            header.replaceChildren(button);
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
            increaseWorkAreaHeight();
        });
    }

    function init() {
        const path = window.location.pathname;
        if (/^\/admin\/admin_pricerelevance\/list\/?$/.test(path)) initPriceRelevance();
        else if (path.startsWith('/admin/supplier/price/compare/')) initCompare();
        else if (path.startsWith('/admin/supplier/price/comparemode/')) initCompareMode();
    }

    init();
})();
