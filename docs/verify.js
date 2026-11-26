/* PharmaTrack — страница покупателя (verify.html).
 * Без входа, без кошелька: всё нужное приходит в ссылке QR-кода
 * (?u=tokenId&s=секрет&c=контракт[&r=rpc]) либо вводится вручную.
 */
/* eslint-disable no-console */
(function () {
  const $ = (id) => document.getElementById(id);

  const CHAIN_NAMES = { 1: 'Ethereum', 11155111: 'Sepolia', 1337: 'Локальная (1337)', 31337: 'Ganache' };
  const shortAddr = (a) => (a ? a.slice(0, 8) + '…' + a.slice(-6) : '—');
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('ru-RU');
  const fmtDateTime = (ts) => new Date(Number(ts) * 1000).toLocaleString('ru-RU');

  const chip = (cls, text) => `<span class="status-chip ${cls}">${text}</span>`;
  const chipOk = (t) => chip('s2', t);
  const chipBad = (t) => chip('s4', t);

  let contract = null;
  let web3 = null;

  function status(text, isError) {
    const el = $('page-status');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  /// Подключение «молча»: адрес контракта и RPC из ссылки, localStorage или config.
  async function connectSilently(qp) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    const rpc = qp.get('r') || localStorage.getItem('rpc') ||
      (isLocal ? PHARMA_CONFIG.localRpc : PHARMA_CONFIG.defaultRpc);
    const address = qp.get('c') || localStorage.getItem('contract') || PHARMA_CONFIG.contractAddress;

    if (!address || !Web3.utils.isAddress(address)) {
      status('В ссылке нет адреса контракта. Откройте страницу по QR-коду с упаковки.', true);
      return false;
    }
    web3 = new Web3(new Web3.providers.HttpProvider(rpc));
    const code = await web3.eth.getCode(address);
    if (code === '0x') {
      status('Контракт не найден в сети «' + rpc + '». Возможно, страница открыта не из той сети.', true);
      return false;
    }
    const abi = await (await fetch('abi.json')).json();
    contract = new web3.eth.Contract(abi, address);
    const chainId = Number(await web3.eth.getChainId());
    status('Сеть: ' + (CHAIN_NAMES[chainId] || '№' + chainId) +
      ' · контракт ' + shortAddr(address) + ' · проверка бесплатна');
    return true;
  }

  /// История партии из событий (неизменяемый журнал аудита).
  async function showHistory(batchId, tokenId) {
    const list = $('history-list');
    list.innerHTML = '<p class="hint">Загрузка истории…</p>';
    try {
      let events = await contract.getPastEvents('allEvents', { fromBlock: 0, filter: { batchId } });
      const byToken = await contract.getPastEvents('allEvents', { fromBlock: 0, filter: { tokenId } });
      events = events.concat(byToken.filter((e) => !('batchId' in e.returnValues)))
        .sort((a, b) => a.blockNumber - b.blockNumber);
      const rows = events.map((e) => {
        const r = e.returnValues;
        switch (e.event) {
          case 'BatchRegistered':
            return `<div class="event-item"><b>🏭 Регистрация партии</b> — «${r.name}», заявлено ${r.quantity} коробок, срок до ${fmtDate(r.expiry)}</div>`;
          case 'UnitsMinted':
            return `<div class="event-item"><b>📦 Выпуск коробок</b> — tokenId ${r.firstTokenId}–${r.lastTokenId}, по токену ERC-721 на коробку</div>`;
          case 'Transfer':
            return `<div class="event-item"><b>🪙 ERC-721 Transfer</b> — выпуск коробки tokenId ${r.tokenId}</div>`;
          case 'CustodyTransferred':
            return `<div class="event-item"><b>🚚 Передача партии</b> — ${shortAddr(r.from)} → ${shortAddr(r.to)}</div>`;
          case 'UnitSold':
            return `<div class="event-item"><b>💰 Продажа коробки</b> — tokenId ${r.tokenId}, ${fmtDateTime(r.soldAt)}, аптека ${shortAddr(r.pharmacy)}</div>`;
          case 'BatchRecalled':
            return `<div class="event-item"><b>⛔ Отзыв партии</b> — ${r.reason} (${fmtDateTime(r.recalledAt)})</div>`;
          default:
            return '';
        }
      }).filter(Boolean);
      list.innerHTML = rows.join('') || '<p class="hint">Событий пока нет.</p>';
      $('history').classList.remove('hidden');
    } catch (e) {
      list.innerHTML = '<p class="hint error">История недоступна: ' + (e.message || '').slice(0, 120) + '</p>';
    }
  }

  /// Главную проверка: вердикт для покупателя.
  async function verify() {
    const tokenId = Number($('v-token').value);
    const secret = $('v-secret').value.trim();
    const verdict = $('verdict');
    verdict.classList.remove('hidden', 'good', 'bad', 'warn');
    $('details').classList.add('hidden');
    $('history').classList.add('hidden');

    if (!tokenId || !secret) {
      verdict.classList.add('warn');
      verdict.innerHTML = '<div class="v-title">Введите номер упаковки и код из QR</div>';
      return;
    }
    if (!contract) {
      const qp = new URLSearchParams(location.search);
      const ok = await connectSilently(qp);
      if (!ok) return;
    }

    try {
      const v = await contract.methods.verifyView(tokenId, secret).call();
      const batch = await contract.methods.getBatch(v.batchId).call();
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
        const custodianRole = Number(await contract.methods.participants(v.custodian).call());
        const where = custodianRole === 4 ? 'легально находится в аптеке' : 'в обороте';
        cls = 'good'; title = '✓ ПОДЛИННАЯ УПАКОВКА';
        sub = `Код подтверждён, коробка ${where}.`;
      }

      verdict.classList.add(cls);
      verdict.innerHTML = `<div class="v-title">${title}</div><div class="v-sub">${sub}</div>`;

      $('details').classList.remove('hidden');
      $('details').innerHTML = `
        <h3>Коробка №${tokenId} — «${batch.name}» (партия #${v.batchId})</h3>
        <dl class="kv">
          <dt>Серийный номер партии</dt><dd class="mono">${batch.serialNumber}</dd>
          <dt>Статус коробки</dt><dd>${Number(v.status) === 1 ? chipBad('Продана ' + fmtDateTime(v.soldAt)) : chipOk('В обороте')}</dd>
          <dt>Выпущена</dt><dd>${fmtDateTime(v.mintedAt)}</dd>
          <dt>Срок годности</dt><dd>${fmtDate(v.expiry)}</dd>
          ${batch.instructionsUrl ? `<dt>Инструкция</dt><dd><a href="${batch.instructionsUrl}" target="_blank" rel="noopener">${batch.instructionsUrl}</a></dd>` : ''}
        </dl>`;

      await showHistory(v.batchId, tokenId);
    } catch (e) {
      verdict.classList.add('bad');
      verdict.innerHTML = `<div class="v-title">✗ ОШИБКА</div><div class="v-sub">Упаковка не найдена в реестре (или неверный номер)</div>`;
      console.error(e);
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    $('btn-verify').onclick = verify;
    $('v-secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });

    // Открыто по QR: поля заполнены из ссылки, проверка стартует автоматически.
    const qp = new URLSearchParams(location.search);
    if (qp.get('u') && qp.get('s')) {
      $('v-token').value = qp.get('u');
      $('v-secret').value = qp.get('s');
      status('Проверяем код в блокчейне…');
      const ok = await connectSilently(qp);
      if (ok) await verify();
    } else {
      status('Введите данные с упаковки или откройте страницу по QR-коду.');
    }
  });
})();
