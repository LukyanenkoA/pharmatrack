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
  const tokenId = Number($('v-token').value);
  const secret = $('v-secret').value.trim();
  const verdict = $('verdict');
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

    const d = $('verify-details');
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

    await showHistory(v.batchId, tokenId, 'verify-history', 'verify-history-list');
  } catch (e) {
    verdict.classList.add('bad');
    verdict.innerHTML = `<div class="v-title">✗ ОШИБКА</div><div class="v-sub">Упаковка не найдена в реестре (или неверный номер)</div>`;
    $('verify-details').classList.add('hidden');
    $('verify-history').classList.add('hidden');
    console.error(e);
  }
}

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
    secrets.forEach((secret, i) => {
      const tokenId = Number(firstTokenId) + i;
      const url = `${location.origin}${location.pathname}?u=${tokenId}&s=${encodeURIComponent(secret)}`;
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
