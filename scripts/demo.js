/**
 * Демонстрационный сценарий PharmaTrack: сериализация упаковок (ERC-721).
 *
 * Запуск: npm run demo            (встроенный ganache — ничего ставить не нужно)
 *         npm run demo -- --rpc http://localhost:8545   (geth --dev / ganache CLI)
 *
 * Сценарий:
 *   1. Админ регистрирует участников (производитель, дистрибьютор, аптека)
 *   2. Производитель регистрирует партию из 10 коробок и выпускает по
 *      токену на каждую коробку (у каждой свой QR-секрет)
 *   3. Партия едет по цепочке: производитель → дистрибьютор → аптека
 *   4. Покупатель бесплатно проверяет коробку №3: «подлинная, в аптеке»
 *   5. Аптека продаёт коробку №3 — продажа необратима, soldAt зафиксирован
 *   6. Покупатель снова проверяет коробку №3: «уже продана <дата>» —
 *      если он держит новую упаковку, это копия (детектор подделки)
 *   7. Подделка: неверный секрет → код недействителен
 *   8. Отзыв партии после продажи части коробок (фармаконадзор)
 *   9. Журнал аудита: вся история партии из событий блокчейна
 */
const { loadBuild, web3FromRpc, web3EmbeddedGanache, sendTx } = require('./common');

const log = (s = '') => console.log(s);
const step = (n, title) => log(`\n--- Шаг ${n}. ${title} ` + '-'.repeat(Math.max(0, 46 - title.length)));
const addr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const dt = (ts) => (Number(ts) > 0 ? new Date(Number(ts) * 1000).toLocaleString('ru-RU') : '—');

const UNIT = { 0: 'в обороте (Active)', 1: 'ПРОДАНА (Sold)' };

async function expectRevert(promise, label) {
  try {
    await promise;
  } catch {
    log(`   ✓ транзакция отклонена блокчейном (revert) — ${label}`);
    return;
  }
  throw new Error(`Ожидалась ошибка: ${label}`);
}

async function main() {
  const rpcUrl = process.argv.includes('--rpc')
    ? process.argv[process.argv.indexOf('--rpc') + 1]
    : null;

  let web3, provider, accounts;
  if (rpcUrl) {
    web3 = web3FromRpc(rpcUrl);
    accounts = (await web3.eth.getAccounts()).map((address) => ({ address }));
  } else {
    ({ web3, provider, accounts } = await web3EmbeddedGanache());
  }
  const [adminAcct, manufacturer, distributor, pharmacy, buyer] = accounts;

  log('='.repeat(72));
  log('  PharmaTrack — сериализация упаковок лекарств на Ethereum (ERC-721)');
  log('='.repeat(72));
  log(`Сеть: ${rpcUrl || 'встроенный ganache (chainId 1337)'}, блок #${await web3.eth.getBlockNumber()}`);

  // --- Деплой контракта ---
  const build = loadBuild();
  const contract = new web3.eth.Contract(build.abi);
  const instance = await sendTx(
    contract.deploy({ data: build.bytecode }).send({ from: adminAcct.address, gas: 4_000_000 }),
    'deploy'
  );
  const pharma = new web3.eth.Contract(build.abi, instance.options.address);
  log(`\nКонтракт задеплоен: ${instance.options.address}`);

  // --- Шаг 1: участники ---
  step(1, 'Админ регистрирует участников цепочки поставок');
  for (const [a, role] of [[manufacturer, 2], [distributor, 3], [pharmacy, 4]]) {
    await sendTx(pharma.methods.addParticipant(a.address, role).send({ from: adminAcct.address, gas: 200000 }), 'add');
  }
  log(`   Производитель: ${addr(manufacturer.address)}   Дистрибьютор: ${addr(distributor.address)}`);
  log(`   Аптека:        ${addr(pharmacy.address)}   Покупатель: ${addr(buyer.address)} (без роли)`);
  await expectRevert(
    pharma.methods.addParticipant(buyer.address, 2).send({ from: buyer.address }),
    'не-админ не может добавлять участников'
  );

  // --- Шаг 2: партия и выпуск коробок ---
  step(2, 'Производитель: партия из 10 коробок + по токену ERC-721 на каждую');
  const expiry = Math.floor(Date.now() / 1000) + 730 * 24 * 3600; // +2 года
  const rcpt = await sendTx(
    pharma.methods
      .registerBatch('Парацетамол 500 мг', 'PCT-2026-0001', 10, expiry, 'https://proizvoditel.example/instrukciya')
      .send({ from: manufacturer.address, gas: 600000 }),
    'registerBatch'
  );
  const batchId = rcpt.events.BatchRegistered.returnValues.batchId;

  const secrets = Array.from({ length: 10 }, (_, i) => `PHARMA-${batchId}-BOX${i + 1}-${Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase()}`);
  const mrcpt = await sendTx(
    pharma.methods.mintUnits(batchId, secrets.map((s) => web3.utils.keccak256(s)))
      .send({ from: manufacturer.address, gas: 4_000_000 }),
    'mintUnits'
  );
  const { firstTokenId } = mrcpt.events.UnitsMinted.returnValues;
  const box3 = Number(firstTokenId) + 2; // коробка №3
  log(`   Партия #${batchId}: 10 коробок выпущено, tokenId ${firstTokenId}–${Number(mrcpt.events.UnitsMinted.returnValues.lastTokenId)}`);
  log(`   QR-код коробки №3: ${secrets[2]} (в блокчейне — только keccak256-хэш)`);
  log(`   totalSupply (ERC-721): ${(await pharma.methods.totalSupply().call())} упаковок`);

  // --- Шаг 3: цепочка поставок ---
  step(3, 'Партия едет по цепочке: производитель → дистрибьютор → аптека');
  await sendTx(pharma.methods.transferCustody(batchId, distributor.address).send({ from: manufacturer.address, gas: 200000 }), '→ d');
  await sendTx(pharma.methods.transferCustody(batchId, pharmacy.address).send({ from: distributor.address, gas: 200000 }), '→ p');
  const b = await pharma.methods.getBatch(batchId).call();
  log(`   Владелец партии: ${addr(b.custodian)}, продано коробок: ${b.soldCount}`);
  log(`   ownerOf(коробка №3) = ${addr(await pharma.methods.ownerOf(box3).call())} (ERC-721: владелец коробки)`);

  // --- Шаг 4: проверка до покупки ---
  step(4, 'Покупатель БЕСПЛАТНО проверяет коробку №3 (verifyView, без газа)');
  let v = await pharma.methods.verifyView(box3, secrets[2]).call({ from: buyer.address });
  log(`   Код подлинный: ${v.codeValid} · статус: ${UNIT[v.status]} · продана: ${dt(v.soldAt)}`);
  log('   ✓ Вердикт покупателя: «подлинная коробка, легально находится в аптеке»');

  // --- Шаг 5: продажа ---
  step(5, 'Аптека продаёт коробку №3 — продажа необратима');
  await sendTx(pharma.methods.markSold(box3).send({ from: pharmacy.address, gas: 200000 }), 'markSold');
  v = await pharma.methods.verifyView(box3, secrets[2]).call({ from: buyer.address });
  log(`   Статус: ${UNIT[v.status]}, soldAt = ${dt(v.soldAt)} (block.timestamp — подделать нельзя)`);
  await expectRevert(
    pharma.methods.markSold(box3).send({ from: pharmacy.address }),
    'повторная продажа той же коробки'
  );
  await expectRevert(
    pharma.methods.transferCustody(batchId, distributor.address).send({ from: pharmacy.address }),
    'партию с проданными коробками передавать нельзя'
  );

  // --- Шаг 6: детектор подделки ---
  step(6, 'ДЕТЕКТОР ПОДДЕЛКИ: «новая» коробка с проданным tokenId');
  v = await pharma.methods.verifyView(box3, secrets[2]).call({ from: buyer.address });
  log(`   verifyView: код подлинный, НО soldAt = ${dt(v.soldAt)}`);
  log('   ⚠ Покупатель держит запечатанную «новую» коробку, а она уже продана');
  log('     в эту дату → перед ним КОПИЯ. Счётчик сканирований не нужен.');

  // --- Шаг 7: подделка ---
  step(7, 'Поддельная коробка: неверный секрет');
  v = await pharma.methods.verifyView(box3, 'PHARMA-FAKE-0000-DEAD').call({ from: buyer.address });
  log(`   Код подлинный: ${v.codeValid} → «УПАКОВКА НЕ НАЙДЕНА В РЕЕСТРЕ»`);

  // --- Шаг 8: отзыв после продаж ---
  step(8, 'Производитель отзывает партию (брак нашли после продажи части коробок)');
  await sendTx(
    pharma.methods.recallBatch(batchId, 'Отклонение по содержанию действующего вещества').send({ from: manufacturer.address, gas: 200000 }),
    'recall'
  );
  const box4 = Number(firstTokenId) + 3;
  v = await pharma.methods.verifyView(box4, secrets[3]).call({ from: buyer.address });
  log(`   Коробка №4 (ещё не продана): recalled = ${v.recalled}, recalledAt = ${dt(v.recalledAt)}`);
  log('   ⚠ Покупатель любой коробки партии видит: «ПАРТИЯ ОТЗВАНА — не покупать»');
  v = await pharma.methods.verifyView(box3, secrets[2]).call({ from: buyer.address });
  log(`   И даже проданная коробка №3: recalled = ${v.recalled} (фармаконадзор)`);

  // --- Шаг 9: аудит ---
  step(9, 'Журнал аудита партии #1 (события блокчейна — стереть невозможно)');
  // UnitSold индексирует tokenId, а не batchId — поэтому читаем все события
  // и фильтруем по партии/диапазону коробок на стороне клиента.
  const lastId = Number(firstTokenId) + 9;
  const events = (await pharma.getPastEvents('allEvents', { fromBlock: 0 })).filter((ev) => {
    const r = ev.returnValues;
    if ('batchId' in r) return String(r.batchId) === String(batchId);
    if (ev.event === 'UnitSold') return Number(r.tokenId) >= Number(firstTokenId) && Number(r.tokenId) <= lastId;
    if (ev.event === 'Transfer') return Number(r.tokenId) >= Number(firstTokenId) && Number(r.tokenId) <= lastId;
    return false;
  }).sort((a, b) => a.blockNumber - b.blockNumber);
  for (const ev of events) {
    const r = ev.returnValues;
    switch (ev.event) {
      case 'BatchRegistered':
        log(`   • BatchRegistered    — «${r.name}», ${r.quantity} коробок заявлено`);
        break;
      case 'Transfer':
        if (Number(r.tokenId) === Number(box3)) log(`   • Transfer (ERC-721)  — минт коробки tokenId ${r.tokenId}`);
        break;
      case 'UnitsMinted':
        log(`   • UnitsMinted        — выпущены tokenId ${r.firstTokenId}–${r.lastTokenId} (ERC-721 Transfer×10)`);
        break;
      case 'CustodyTransferred':
        log(`   • CustodyTransferred — ${addr(r.from)} → ${addr(r.to)}`);
        break;
      case 'UnitSold':
        log(`   • UnitSold           — коробка tokenId ${r.tokenId} продана ${dt(r.soldAt)}`);
        break;
      case 'BatchRecalled':
        log(`   • BatchRecalled      — ${r.reason} (${dt(r.recalledAt)})`);
        break;
      default:
        log(`   • ${ev.event}`);
    }
  }

  log('\n' + '='.repeat(72));
  log('  Итог: уникальный токен + необратимый Sold с датой = детектор подделок.');
  log('  Покупатель платит 0 газа: проверка — бесплатный view-вызов.');
  log('='.repeat(72));

  if (provider && provider.close) await provider.close();
}

main().catch((err) => {
  console.error('Ошибка демонстрации:', err);
  process.exit(1);
});
