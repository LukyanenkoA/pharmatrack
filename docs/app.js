/* PharmaTrack — фронтенд (web3.js; модель упаковок ERC-721, без сборки) */
/* eslint-disable no-console */

const $ = (id) => document.getElementById(id);

const ROLE_NAMES = ['Без роли', 'Админ', 'Производитель', 'Дистрибьютор', 'Аптека'];
const UNIT_STATUS = ['В обороте', 'Продана'];
const CHAIN_NAMES = { 1: 'Ethereum', 11155111: 'Sepolia', 1337: 'Локальная (1337)', 31337: 'Ganache/Hardhat' };

const state = { web3: null, chainId: 0, account: null, role: 0, contract: null, abi: null, accounts: [] };

/* ---------------- утилиты ---------------- */

const shortAddr = (a) => (a ? a.slice(0, 8) + '…' + a.slice(-6) : '—');
const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('ru-RU');
const fmtDateTime = (ts) => new Date(Number(ts) * 1000).toLocaleString('ru-RU');

function statusChip(cls, text) {
  return `<span class="status-chip ${cls}">${text}</span>`;
}
const chipOk = (t) => statusChip('s2', t);
const chipWarn = (t) => statusChip('s1', t);
const chipBad = (t) => statusChip('s4', t);
const chipMuted = (t) => statusChip('s3', t);

async function sendTx(promise) {
  const receipt = await promise;
  if (!receipt.status) throw new Error('Транзакция отклонена блокчейном');
  return receipt;
}

function batchStateChip(b) {
  if (Number(b.recalledAt) !== 0) return chipBad('Отозвана');
  if (Number(b.soldCount) > 0) return chipWarn('Частично продана');
  if (Number(b.mintedCount) === 0) return chipMuted('Зарегистрирована');
  return chipOk('В обороте');
}

/* ---------------- подключение ---------------- */

async function loadAbi() {
  const res = await fetch('abi.json');
  if (!res.ok) throw new Error('abi.json не найден — сначала выполните npm run compile');
  state.abi = await res.json();
  return state.abi;
}

function readSettings() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  $('rpc-url').value = localStorage.getItem('rpc') || (isLocal ? PHARMA_CONFIG.localRpc : PHARMA_CONFIG.defaultRpc);
  $('contract-addr').value = localStorage.getItem('contract') || PHARMA_CONFIG.contractAddress || '';
}

async function connect({ useMetaMask = false } = {}) {
  const errBox = 'connect-error';
  $(errBox).classList.add('hidden');
  try {
    if (!state.abi) await loadAbi();

    const address = $('contract-addr').value.trim();
    if (!Web3.utils.isAddress(address)) throw new Error('Укажите корректный адрес контракта (0x…)');

    let account = null;
    let allAccounts = [];
    if (useMetaMask) {
      if (!window.ethereum) throw new Error('MetaMask не установлена');
      allAccounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      account = allAccounts[0];
      state.web3.setProvider(window.ethereum);
    } else {
      const rpc = $('rpc-url').value.trim();
      state.web3 = new Web3(new Web3.providers.HttpProvider(rpc));
      allAccounts = await state.web3.eth.getAccounts();
      account = allAccounts[0] || null; // публичный RPC: только просмотр
    }

    const code = await state.web3.eth.getCode(address);
    if (code === '0x') throw new Error('По этому адресу нет смарт-контракта (сеть верная?)');

    state.contract = new state.web3.eth.Contract(state.abi, address);
    state.account = account;
    state.accounts = allAccounts;
    state.chainId = Number(await state.web3.eth.getChainId());
    state.role = account ? Number(await state.contract.methods.participants(account).call()) : 0;

    localStorage.setItem('rpc', $('rpc-url').value.trim());
    localStorage.setItem('contract', address);

    renderStatus();
    $('connect-panel').classList.add('hidden');
    $('app').classList.remove('hidden');
    await refreshAll();

    // Автопроверка, если пришли по QR-ссылке (?u=…&s=…)
    const p = new URLSearchParams(location.search);
    if (p.get('u') && p.get('s')) {
      $('v-token').value = p.get('u');
      $('v-secret').value = p.get('s');
      switchTab('verify');
      verify();
    }
  } catch (e) {
    msg(errBox, 'Ошибка подключения: ' + e.message, true);
  }
}

function renderStatus() {
  const bar = $('status-bar');
  bar.classList.remove('offline');
  bar.classList.add('online');
  $('net-name').textContent = CHAIN_NAMES[state.chainId] || `Сеть #${state.chainId}`;
  $('acct').textContent = state.account ? shortAddr(state.account) : 'режим просмотра';
  const badge = $('role-badge');
  badge.classList.remove('hidden');
  badge.textContent = ROLE_NAMES[state.role];
  $('contract-foot').textContent = shortAddr(state.contract.options.address);

  const sel = $('acct-select');
  if (state.accounts.length > 1) {
    sel.classList.remove('hidden');
    sel.innerHTML = state.accounts
      .map((a) => `<option value="${a}" ${a === state.account ? 'selected' : ''}>${shortAddr(a)}</option>`)
      .join('');
  }
}

async function switchAccount(addr) {
  state.account = addr;
  state.role = Number(await state.contract.methods.participants(addr).call());
  renderStatus();
  await refreshAll();
}

/* ---------------- вкладки ---------------- */

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

/* ---------------- проверка покупателем ---------------- */

async function verify() {
  await runVerification('verdict', 'verify-details', 'verify-history', 'verify-history-list',
    $('v-token').value, $('v-secret').value);
}

/// Общая проверка: рендерит вердикт в переданные элементы (служебная вкладка или режим покупателя).
async function runVerification(verdictId, detailsId, historyWrapId, historyListId, tokenInput, secretInput) {
  const tokenId = Number(tokenInput);
  const secret = String(secretInput).trim();
  const verdict = $(verdictId);
  verdict.classList.remove('hidden', 'good', 'bad', 'warn');
  if (!tokenId || !secret) {
    verdict.classList.add('warn');
    verdict.innerHTML = '<div class="v-title">Введите номер упаковки и код</div>';
    return;
  }

  try {
    const v = await state.contract.methods.verifyView(tokenId, secret).call();
    const batch = await state.contract.methods.getBatch(v.batchId).call();
    const expired = Number(v.expiry) * 1000 < Date.now();

    let cls, title, sub;
    if (!v.codeValid) {
      cls = 'bad'; title = '✗ ПОДДЕЛКА';
      sub = 'Код не найден в реестре. Упаковка не выпускалась производителем — откажитесь от покупки.';
    } else if (v.recalled) {
      cls = 'bad'; title = '✗ ПАРТИЯ ОТЗВАНА';
      sub = `Производитель отозвал партию ${fmtDate(v.recalledAt)}: ${batch.recallReason || 'причина не указана'}. Покупать запрещено.`;
    } else if (expired) {
      cls = 'warn'; title = '⚠ СРОК ГОДНОСТИ ИСТЁК';
      sub = 'Код подлинный, но препарат просрочен.';
    } else if (Number(v.status) === 1) {
      cls = 'bad'; title = '✗ УЖЕ ПРОДАНА ' + fmtDateTime(v.soldAt);
      sub = 'Код подлинный, но эта коробка продана именно в эту дату. ' +
            'Если вы держите запечатанную «новую» коробку с этим кодом — перед вами КОПИЯ.';
    } else {
      const custodianRole = Number(await state.contract.methods.participants(v.custodian).call());
      const where = custodianRole === 4 ? 'легально находится в аптеке' : `в обороте (владелец: ${shortAddr(v.custodian)})`;
      cls = 'good'; title = '✓ ПОДЛИННАЯ УПАКОВКА';
      sub = `Код подтверждён, коробка ${where}.`;
    }

    verdict.classList.add(cls);
    verdict.innerHTML = `<div class="v-title">${title}</div><div class="v-sub">${sub}</div>`;

    const d = $(detailsId);
    d.classList.remove('hidden');
    d.innerHTML = `
      <h3>Коробка №${tokenId} — «${batch.name}» (партия #${v.batchId})</h3>
      <dl class="kv">
        <dt>Серийный номер партии</dt><dd class="mono">${batch.serialNumber}</dd>
        <dt>Статус коробки</dt><dd>${Number(v.status) === 1 ? chipBad('Продана ' + fmtDateTime(v.soldAt)) : chipOk('В обороте')}</dd>
        <dt>Выпущена (mintedAt)</dt><dd>${fmtDateTime(v.mintedAt)}</dd>
        <dt>Срок годности</dt><dd>${fmtDate(v.expiry)}</dd>
        <dt>Владелец партии</dt><dd class="mono">${v.custodian}</dd>
        ${batch.instructionsUrl ? `<dt>Инструкция</dt><dd><a href="${batch.instructionsUrl}" target="_blank" rel="noopener">${batch.instructionsUrl}</a></dd>` : ''}
      </dl>`;

    await showHistory(v.batchId, tokenId, historyWrapId, historyListId);
  } catch (e) {
    verdict.classList.add('bad');
    verdict.innerHTML = `<div class="v-title">✗ ОШИБКА</div><div class="v-sub">Упаковка не найдена в реестре (или неверный номер)</div>`;
    $(detailsId).classList.add('hidden');
    $(historyWrapId).classList.add('hidden');
    console.error(e);
  }
}

/* ---------------- ссылка QR → отдельная страница покупателя ---------------- */

/* ---------------- производитель ---------------- */

function randomSecret(label, i) {
  const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  return `PHARMA-${label}-BOX${i}-${hex()}`;
}

async function registerBatch() {
  const name = $('m-name').value.trim();
  const serial = $('m-serial').value.trim();
  const qty = Number($('m-qty').value);
  const expiry = $('m-expiry').value ? Math.floor(new Date($('m-expiry').value).getTime() / 1000) : 0;
  const instr = $('m-instr').value.trim();

  if (!state.account) return alert('Подключите аккаунт производителя (MetaMask или локальный RPC).');
  if (!name || !serial || !qty || !expiry) return alert('Заполните название, серийник, количество и срок годности.');
  if (qty > 250) return alert('Выпускайте не более 250 коробок за одну транзакцию (лимит газа блока).');

  try {
    // 1. Регистрация партии.
    const rcpt = await sendTx(
      state.contract.methods.registerBatch(name, serial, qty, expiry, instr)
        .send({ from: state.account, gas: 700000 })
    );
    const batchId = rcpt.events.BatchRegistered.returnValues.batchId;

    // 2. Выпуск коробок: по токену на коробку, у каждой свой секрет.
    const secrets = Array.from({ length: qty }, (_, i) => randomSecret(batchId, i + 1));
    const mrcpt = await sendTx(
      state.contract.methods.mintUnits(batchId, secrets.map((s) => Web3.utils.keccak256(s)))
        .send({ from: state.account, gas: 8_000_000 })
    );
    const { firstTokenId } = mrcpt.events.UnitsMinted.returnValues;

    // 3. QR-коды коробок.
    $('qr-result').classList.remove('hidden');
    $('qr-batch-id').textContent = batchId;
    const grid = $('qr-grid');
    grid.innerHTML = '';
    const lines = [`Партия #${batchId} «${name}» — секреты коробок`, ''];
    const contractQ = state.contract.options.address;
    const rpcQ = encodeURIComponent($('rpc-url').value.trim());
    secrets.forEach((secret, i) => {
      const tokenId = Number(firstTokenId) + i;
      // QR самодостаточен: ведёт на отдельную страницу покупателя verify.html,
      // в ссылке — номер коробки, секрет, адрес контракта и RPC.
      const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}verify.html?u=${tokenId}&s=${encodeURIComponent(secret)}&c=${contractQ}&r=${rpcQ}`;
      lines.push(`Коробка tokenId ${tokenId}: ${secret}  (${url})`);

      const cell = document.createElement('div');
      cell.className = 'qr-cell';
      cell.innerHTML = `<div class="qr-box"></div>
        <div class="qr-cap">Коробка №${tokenId}</div>
        <div class="qr-cap mono small">${secret}</div>
        <button class="qr-dl" data-id="${tokenId}">Скачать QR</button>`;
      grid.appendChild(cell);
      new QRCode(cell.querySelector('.qr-box'), { text: url, width: 130, height: 130, correctLevel: QRCode.CorrectLevel.M });
    });
    grid.querySelectorAll('.qr-dl').forEach((btn) => {
      btn.onclick = () => {
        const canvas = btn.closest('.qr-cell').querySelector('canvas');
        const a = document.createElement('a');
        a.download = `pharmatrack-box-${btn.dataset.id}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
      };
    });
    $('btn-secrets-download').onclick = () => {
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.download = `pharmatrack-batch-${batchId}-secrets.txt`;
      a.href = URL.createObjectURL(blob);
      a.click();
    };

    await refreshAll();
  } catch (e) {
    alert('Выпуск не удался: ' + (e.message || '').slice(0, 160));
  }
}

/* ---------------- логистика и аптека ---------------- */

async function transferCustody() {
  const batchId = $('l-batch').value;
  const to = $('l-to').value.trim();
  if (!batchId || !Web3.utils.isAddress(to)) return alert('Выберите партию и укажите корректный адрес получателя.');
  try {
    await sendTx(state.contract.methods.transferCustody(batchId, to).send({ from: state.account, gas: 200000 }));
    alert('Партия передана. Владелец обновлён в блокчейне.');
    await refreshAll();
  } catch (e) {
    alert('Передача не удалась: ' + (e.message || '').slice(0, 160));
  }
}

async function markSold() {
  const tokenId = $('p-unit').value;
  if (!tokenId) return alert('Нет коробок для продажи.');
  try {
    await sendTx(state.contract.methods.markSold(tokenId).send({ from: state.account, gas: 200000 }));
    alert('Продажа зафиксирована навсегда: soldAt записан в блокчейн.');
    await refreshAll();
  } catch (e) {
    alert('Не удалось отметить продажу: ' + (e.message || '').slice(0, 160));
  }
}

/// Обновить список коробок выбранной партии в аптеке.
async function refreshPharmacyUnits() {
  const sel = $('p-unit');
  const batchId = $('p-batch').value;
  if (!batchId) { sel.innerHTML = '<option value="">— нет коробок —</option>'; return; }
  const ids = await state.contract.methods.getUnitIds(batchId).call();
  const units = await Promise.all(ids.map((id) => state.contract.methods.getUnit(id).call()));
  const active = ids.filter((id, i) => Number(units[i].status) === 0);
  sel.innerHTML = active.map((id) => `<option value="${id}">Коробка №${id}</option>`).join('')
    || '<option value="">— все коробки проданы —</option>';
}

/* ---------------- админ ---------------- */

async function addParticipant(remove) {
  const addr = $('a-addr').value.trim();
  const role = Number($('a-role').value);
  if (!Web3.utils.isAddress(addr)) return alert('Укажите корректный адрес кошелька.');
  try {
    const method = remove
      ? state.contract.methods.removeParticipant(addr)
      : state.contract.methods.addParticipant(addr, role);
    await sendTx(method.send({ from: state.account, gas: 200000 }));
    alert(remove ? 'Участник исключён.' : 'Роль выдана: ' + ROLE_NAMES[role]);
    await refreshAll();
  } catch (e) {
    alert('Операция не удалась: ' + (e.message || '').slice(0, 160));
  }
}

/* ---------------- реестр партий и история ---------------- */

async function refreshAll() {
  await refreshBatches();
  await refreshParticipantsLog();
}

async function refreshBatches() {
  const ids = await state.contract.methods.getBatchIds().call();
  const batches = await Promise.all(ids.map((id) => state.contract.methods.getBatch(id).call()));

  const tbody = $('batches-table').querySelector('tbody');
  tbody.innerHTML = batches.map((b) => `
    <tr data-id="${b.id}">
      <td>#${b.id}</td><td>${b.name}</td>
      <td>${b.mintedCount}/${b.quantity}</td>
      <td>${b.soldCount}</td>
      <td>${batchStateChip(b)}</td>
      <td class="mono">${shortAddr(b.custodian)}</td>
    </tr>`).join('') || '<tr><td colspan="6">Партий пока нет — выпустите первую.</td></tr>';

  tbody.querySelectorAll('tr[data-id]').forEach((tr) =>
    tr.onclick = () => showBatchDetails(tr.dataset.id));

  // Списки для передачи и продажи: партии, где я владелец.
  const mine = batches.filter((b) =>
    state.account && b.custodian.toLowerCase() === state.account.toLowerCase());
  const transferable = mine.filter((b) => Number(b.recalledAt) === 0 && Number(b.soldCount) === 0);
  const inPharmacy = mine.filter((b) => Number(b.recalledAt) === 0);

  const lsel = $('l-batch');
  lsel.innerHTML = transferable.map((b) => `<option value="${b.id}">#${b.id} — ${b.name}</option>`).join('')
    || '<option value="">— нет партий —</option>';

  const psel = $('p-batch');
  psel.innerHTML = inPharmacy.map((b) => `<option value="${b.id}">#${b.id} — ${b.name} (продано ${b.soldCount}/${b.mintedCount})</option>`).join('')
    || '<option value="">— нет партий в аптеке —</option>';
  psel.onchange = refreshPharmacyUnits;
  await refreshPharmacyUnits();

  $('my-batches').innerHTML = mine.length
    ? mine.map((b) => `<div class="event-item">Партия #${b.id} «${b.name}» — коробок: ${b.mintedCount}/${b.quantity}, продано: ${b.soldCount} ${Number(b.recalledAt) !== 0 ? chipBad('отозвана') : ''}</div>`).join('')
    : '<p class="hint">Вы не владеете ни одной партией.</p>';
}

async function showBatchDetails(id) {
  const b = await state.contract.methods.getBatch(id).call();
  const unitIds = await state.contract.methods.getUnitIds(id).call();
  const units = await Promise.all(unitIds.map((tid) => state.contract.methods.getUnit(tid).call()));
  const canRecall = [1, 2].includes(state.role) && Number(b.recalledAt) === 0;

  const el = $('batch-details');
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3>Партия #${id} — «${b.name}» ${batchStateChip(b)}</h3>
    <dl class="kv">
      <dt>Серийный номер</dt><dd class="mono">${b.serialNumber}</dd>
      <dt>Коробок выпущено</dt><dd>${b.mintedCount} из ${b.quantity}</dd>
      <dt>Продано</dt><dd>${b.soldCount}</dd>
      <dt>Производитель</dt><dd class="mono">${b.manufacturer}</dd>
      <dt>Владелец</dt><dd class="mono">${b.custodian}</dd>
      <dt>Срок годности</dt><dd>${fmtDate(b.expiry)}</dd>
      <dt>Зарегистрирована</dt><dd>${fmtDateTime(b.createdAt)}</dd>
      ${Number(b.recalledAt) !== 0 ? `<dt>Отзыв</dt><dd>${chipBad(fmtDateTime(b.recalledAt) + ' — ' + b.recallReason)}</dd>` : ''}
    </dl>
    ${canRecall ? '<div class="btn-row"><button id="btn-recall" class="primary">Отозвать партию</button></div>' : ''}
    <h3 style="margin-top:14px">Коробки</h3>
    <table><thead><tr><th>tokenId</th><th>Статус</th><th>Выпущена</th><th>Продана</th></tr></thead>
    <tbody>${unitIds.map((tid, i) => `
      <tr><td>#${tid}</td>
      <td>${Number(units[i].status) === 1 ? chipBad('Продана') : chipOk('В обороте')}</td>
      <td>${fmtDateTime(units[i].mintedAt)}</td>
      <td>${Number(units[i].soldAt) > 0 ? fmtDateTime(units[i].soldAt) : '—'}</td></tr>`).join('')}
    </tbody></table>
    <h3 style="margin-top:14px">История партии</h3><div id="details-history"></div>`;

  const recallBtn = $('btn-recall');
  if (recallBtn) recallBtn.onclick = async () => {
    const reason = prompt('Причина отзыва:', 'Брак партии');
    if (!reason) return;
    try {
      await sendTx(state.contract.methods.recallBatch(id, reason).send({ from: state.account, gas: 200000 }));
      alert('Партия отозвана.');
      await refreshAll();
      showBatchDetails(id);
    } catch (e) { alert('Не удалось отозвать: ' + (e.message || '').slice(0, 140)); }
  };
  await showHistory(id, null, null, 'details-history');
}

async function showHistory(batchId, tokenId, wrapperId, listId) {
  if (wrapperId) $(wrapperId).classList.remove('hidden');
  const list = $(listId);
  list.innerHTML = '<p class="hint">Загрузка истории…</p>';
  try {
    let events;
    try {
      events = await state.contract.getPastEvents('allEvents', { fromBlock: 0, filter: { batchId } });
    } catch {
      // Публичные RPC иногда ограничивают диапазон блоков — пробуем последние ~90 дней.
      const from = Math.max(0, (await state.web3.eth.getBlockNumber()) - 2_000_000);
      events = await state.contract.getPastEvents('allEvents', { fromBlock: from, filter: { batchId } });
    }
    // UnitSold/Transfer индексируют tokenId, а не batchId — дочитываем отдельно.
    if (tokenId) {
      const byToken = await state.contract.getPastEvents('allEvents', { fromBlock: 0, filter: { tokenId } });
      events = events.concat(byToken.filter((e) => !('batchId' in e.returnValues)));
    }
    events.sort((a, b) => a.blockNumber - b.blockNumber);
    list.innerHTML = events.map((e) => {
      const r = e.returnValues;
      switch (e.event) {
        case 'BatchRegistered':
          return `<div class="event-item"><b>🏭 Регистрация партии</b> — «${r.name}», заявлено ${r.quantity} коробок, срок до ${fmtDate(r.expiry)} <span class="when">блок ${e.blockNumber}</span></div>`;
        case 'UnitsMinted':
          return `<div class="event-item"><b>📦 Выпуск коробок</b> — tokenId ${r.firstTokenId}–${r.lastTokenId}, по токену ERC-721 на коробку <span class="when">блок ${e.blockNumber}</span></div>`;
        case 'Transfer':
          return `<div class="event-item"><b>🪙 ERC-721 Transfer</b> — минт коробки tokenId ${r.tokenId} <span class="when">блок ${e.blockNumber}</span></div>`;
        case 'CustodyTransferred':
          return `<div class="event-item"><b>🚚 Передача партии</b> — ${shortAddr(r.from)} → ${shortAddr(r.to)} <span class="when">блок ${e.blockNumber}</span></div>`;
        case 'UnitSold':
          return `<div class="event-item"><b>💰 Продажа коробки</b> — tokenId ${r.tokenId}, продана ${fmtDateTime(r.soldAt)} аптекой ${shortAddr(r.pharmacy)} <span class="when">блок ${e.blockNumber}</span></div>`;
        case 'BatchRecalled':
          return `<div class="event-item"><b>⛔ Отзыв партии</b> — ${r.reason} (${fmtDateTime(r.recalledAt)}) <span class="when">блок ${e.blockNumber}</span></div>`;
        default:
          return `<div class="event-item"><b>${e.event}</b> <span class="when">блок ${e.blockNumber}</span></div>`;
      }
    }).join('') || '<p class="hint">Событий пока нет.</p>';
  } catch (e) {
    list.innerHTML = '<p class="hint error">История недоступна: ' + (e.message || '').slice(0, 120) + '</p>';
  }
}

async function refreshParticipantsLog() {
  const list = $('participants-log');
  try {
    const added = await state.contract.getPastEvents('ParticipantAdded', { fromBlock: 0 });
    const removed = await state.contract.getPastEvents('ParticipantRemoved', { fromBlock: 0 });
    const active = new Map(added.map((e) => [e.returnValues.participant.toLowerCase(), e.returnValues.role]));
    for (const e of removed) active.delete(e.returnValues.participant.toLowerCase());
    list.innerHTML = [...active.entries()].map(([addr, role]) =>
      `<div class="event-item"><span class="mono">${addr}</span> — ${ROLE_NAMES[role]}</div>`).join('')
      || '<p class="hint">Участников нет.</p>';
  } catch {
    list.innerHTML = '<p class="hint">Журнал участников недоступен на этом RPC.</p>';
  }
}

/* ---------------- инициализация ---------------- */

window.addEventListener('DOMContentLoaded', () => {
  readSettings();
  state.web3 = new Web3(); // заготовка, провайдер подставится при подключении
  $('btn-connect-rpc').onclick = () => connect({ useMetaMask: false });
  $('btn-connect-mm').onclick = () => connect({ useMetaMask: true });
  $('btn-verify').onclick = verify;
  $('btn-register').onclick = registerBatch;
  $('btn-transfer').onclick = transferCustody;
  $('btn-sold').onclick = markSold;
  $('btn-add-participant').onclick = () => addParticipant(false);
  $('btn-remove-participant').onclick = () => addParticipant(true);
  $('acct-select').onchange = (e) => switchAccount(e.target.value);
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));

  // Открыто по QR-ссылке (?u=…&s=…): отправляем на страницу покупателя.
  const qp = new URLSearchParams(location.search);
  if (qp.get('u') && qp.get('s')) {
    location.replace('verify.html' + location.search);
  }
});
