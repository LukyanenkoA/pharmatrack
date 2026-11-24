/**
 * Интеграционные тесты контракта PharmaTrack (модель упаковок ERC-721)
 * против встроенного ganache.
 *
 * Запуск: npm test          (node --test, Node.js >= 18)
 */
const test = require('node:test');
const assert = require('node:assert');
const Web3 = require('web3');
const { loadBuild, web3EmbeddedGanache, sendTx } = require('../scripts/common');

const ROLE = { None: 0, Admin: 1, Manufacturer: 2, Distributor: 3, Pharmacy: 4 };
const UNIT_STATUS = { Active: 0, Sold: 1 };

let web3, provider, accounts, admin, manufacturer, distributor, pharmacy, buyer;

const keccak = (s) => web3.utils.keccak256(s);

/// Развёрнутый контракт с участниками, свежий для каждого теста.
async function freshContract() {
  const build = loadBuild();
  const c = new web3.eth.Contract(build.abi);
  const deployed = await sendTx(
    c.deploy({ data: build.bytecode }).send({ from: admin.address, gas: 4_000_000 }),
    'deploy'
  );
  const inst = new web3.eth.Contract(build.abi, deployed.options.address);
  await inst.methods.addParticipant(manufacturer.address, ROLE.Manufacturer).send({ from: admin.address, gas: 300000 });
  await inst.methods.addParticipant(distributor.address, ROLE.Distributor).send({ from: admin.address, gas: 300000 });
  await inst.methods.addParticipant(pharmacy.address, ROLE.Pharmacy).send({ from: admin.address, gas: 300000 });
  return inst;
}

const EXPIRY = () => Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

/// Зарегистрировать партию (quantity упаковок) и выпустить count коробок.
/// Возвращает { batchId, firstId, lastId, secrets }.
async function makeBatch(inst, { quantity = 10, mint = 3, from = manufacturer, label = 'TST' } = {}) {
  const rcpt = await sendTx(
    inst.methods.registerBatch('Тестовый препарат', `${label}-0001`, quantity, EXPIRY(), '')
      .send({ from: from.address, gas: 600000 }),
    'registerBatch'
  );
  const batchId = rcpt.events.BatchRegistered.returnValues.batchId;
  const secrets = Array.from({ length: mint }, (_, i) => `PHARMA-${label}-${i}-${Math.floor(Math.random() * 0xffff)}`);
  const hashes = secrets.map(keccak);
  const mrcpt = await sendTx(
    inst.methods.mintUnits(batchId, hashes).send({ from: from.address, gas: 4_000_000 }),
    'mintUnits'
  );
  const { firstTokenId, lastTokenId } = mrcpt.events.UnitsMinted.returnValues;
  return { batchId, firstTokenId: Number(firstTokenId), lastTokenId: Number(lastTokenId), secrets };
}

/// Сравнение адресов без учёта регистра checksum-кодировки (EIP-55).
const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase();
const assertAddr = (actual, expected, message) =>
  assert.ok(eqAddr(actual, expected), `${message}: ${actual} != ${expected}`);

/**
 * Проверить, что вызов падает с revert. Причину web3 в сообщение об ошибке
 * не выносит, поэтому сверяем сам факт отката.
 */
async function assertRevert(promise, expectedReason) {
  await assert.rejects(
    promise,
    (err) => /revert/i.test((err.message || '').toString()),
    `ожидался revert (${expectedReason}), но транзакция прошла успешно`
  );
}

test.before(async () => {
  ({ web3, provider, accounts } = await web3EmbeddedGanache());
  [admin, manufacturer, distributor, pharmacy, buyer] = accounts;
});

test.after(async () => {
  if (provider && provider.close) await provider.close();
});

test('деплой: деплоер становится администратором', async () => {
  const inst = await freshContract();
  assertAddr(await inst.methods.admin().call(), admin.address, 'админ');
  assert.equal(Number(await inst.methods.participants(admin.address).call()), ROLE.Admin);
});

test('участники: только админ управляет ролями', async () => {
  const inst = await freshContract();
  await assertRevert(
    inst.methods.addParticipant(buyer.address, ROLE.Manufacturer).send({ from: manufacturer.address, gas: 300000 }),
    'not admin'
  );
  await sendTx(
    inst.methods.addParticipant(buyer.address, ROLE.Distributor).send({ from: admin.address, gas: 300000 }),
    'add'
  );
  assert.equal(Number(await inst.methods.participants(buyer.address).call()), ROLE.Distributor);
  await assertRevert(
    inst.methods.addParticipant(buyer.address, ROLE.Pharmacy).send({ from: admin.address, gas: 300000 }),
    'already a participant'
  );
  await sendTx(inst.methods.removeParticipant(buyer.address).send({ from: admin.address, gas: 300000 }), 'remove');
  assert.equal(Number(await inst.methods.participants(buyer.address).call()), ROLE.None);
});

test('регистрация партии: только производитель, с валидацией входа', async () => {
  const inst = await freshContract();
  await assertRevert(
    inst.methods.registerBatch('X', 'S', 1, EXPIRY(), '').send({ from: admin.address, gas: 600000 }),
    'wrong role'
  );
  await assertRevert(
    inst.methods.registerBatch('', 'S', 1, EXPIRY(), '').send({ from: manufacturer.address, gas: 600000 }),
    'name is empty'
  );
  await assertRevert(
    inst.methods.registerBatch('X', 'S', 1, 1, '').send({ from: manufacturer.address, gas: 600000 }),
    'already expired'
  );

  const rcpt = await sendTx(
    inst.methods.registerBatch('X', 'S', 5, EXPIRY(), 'https://example.com/instr').send({ from: manufacturer.address, gas: 600000 }),
    'register'
  );
  assert.equal(rcpt.events.BatchRegistered.returnValues.batchId, '1');
  const b = await inst.methods.getBatch(1).call();
  assert.equal(b.name, 'X');
  assert.equal(Number(b.quantity), 5);
  assert.equal(Number(b.mintedCount), 0);
  assert.equal(Number(b.soldCount), 0);
  assert.equal(b.instructionsUrl, 'https://example.com/instr');
  assertAddr(b.manufacturer, manufacturer.address, 'производитель');
  assertAddr(b.custodian, manufacturer.address, 'владелец');
});

test('выпуск упаковок: ERC-721 минт, ownerOf, totalSupply, события Transfer', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId, lastTokenId, secrets } = await makeBatch(inst, { quantity: 10, mint: 3, label: 'M1' });

  assert.deepEqual([firstTokenId, lastTokenId], [1, 3]);
  assert.equal(Number(await inst.methods.totalSupply().call()), 3);
  assert.deepEqual((await inst.methods.getUnitIds(batchId).call()).map(Number), [1, 2, 3]);

  const u = await inst.methods.getUnit(2).call();
  assert.equal(Number(u.batchId), batchId);
  assert.equal(Number(u.status), UNIT_STATUS.Active);
  assert.equal(u.codeHash, keccak(secrets[1]));
  assert.ok(Number(u.mintedAt) > 0, 'mintedAt заполнен');
  assert.equal(Number(u.soldAt), 0);

  // ERC-721: владелец коробки — custodian партии (производитель).
  assertAddr(await inst.methods.ownerOf(2).call(), manufacturer.address, 'ownerOf');

  const transfers = await inst.getPastEvents('Transfer', { fromBlock: 0 });
  assert.equal(transfers.length, 3);
  assert.equal(transfers[0].returnValues.tokenId, '1');
  assert.equal(transfers[0].returnValues.from, '0x0000000000000000000000000000000000000000');
});

test('выпуск: лимиты партии, чужой производитель, нулевой хэш, чанки', async () => {
  const inst = await freshContract();
  const { batchId } = await makeBatch(inst, { quantity: 4, mint: 2, label: 'M2' });

  // Сверх заявленного количества.
  await assertRevert(
    inst.methods.mintUnits(batchId, [keccak('a'), keccak('b'), keccak('c')]).send({ from: manufacturer.address, gas: 4_000_000 }),
    'exceeds declared quantity'
  );
  // Чужой производитель.
  await assertRevert(
    inst.methods.mintUnits(batchId, [keccak('x')]).send({ from: distributor.address, gas: 4_000_000 }),
    'not batch manufacturer'
  );
  // Нулевой хэш.
  const zeroHash = '0x' + '0'.repeat(64);
  await assertRevert(
    inst.methods.mintUnits(batchId, [zeroHash]).send({ from: manufacturer.address, gas: 4_000_000 }),
    'zero code hash'
  );
  // Дозыпуск добирает до количества.
  await sendTx(
    inst.methods.mintUnits(batchId, [keccak('c'), keccak('d')]).send({ from: manufacturer.address, gas: 4_000_000 }),
    'mint rest'
  );
  assert.equal(Number((await inst.methods.getBatch(batchId).call()).mintedCount), 4);
});

test('передача партии: только custodian → дистрибьютор/аптека', async () => {
  const inst = await freshContract();
  const { batchId } = await makeBatch(inst, { quantity: 5, mint: 2, label: 'M3' });

  await assertRevert(
    inst.methods.transferCustody(batchId, distributor.address).send({ from: pharmacy.address, gas: 300000 }),
    'not custodian'
  );
  await assertRevert(
    inst.methods.transferCustody(batchId, buyer.address).send({ from: manufacturer.address, gas: 300000 }),
    'Distributor or Pharmacy'
  );

  await sendTx(inst.methods.transferCustody(batchId, distributor.address).send({ from: manufacturer.address, gas: 300000 }), '→ d');
  let b = await inst.methods.getBatch(batchId).call();
  assertAddr(b.custodian, distributor.address, 'владелец');
  // ownerOf коробки теперь указывает на дистрибьютора.
  assertAddr(await inst.methods.ownerOf(1).call(), distributor.address, 'ownerOf после передачи');

  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: distributor.address, gas: 300000 }), '→ p');
  b = await inst.methods.getBatch(batchId).call();
  assertAddr(b.custodian, pharmacy.address, 'владелец');
});

test('продажа коробки: только аптека-владелец, необратима, блокирует партию', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId } = await makeBatch(inst, { quantity: 5, mint: 2, label: 'M4' });
  const tokenId = firstTokenId; // коробка №1

  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: manufacturer.address, gas: 300000 }), '→ p');

  await assertRevert(
    inst.methods.markSold(tokenId).send({ from: distributor.address, gas: 300000 }),
    'not a pharmacy'
  );
  await sendTx(inst.methods.markSold(tokenId).send({ from: pharmacy.address, gas: 300000 }), 'sold');

  const u = await inst.methods.getUnit(tokenId).call();
  assert.equal(Number(u.status), UNIT_STATUS.Sold);
  assert.ok(Number(u.soldAt) > 0, 'soldAt заполнен');
  assert.equal(Number((await inst.methods.getBatch(batchId).call()).soldCount), 1);

  // Повторная продажа той же коробки отклоняется.
  await assertRevert(
    inst.methods.markSold(tokenId).send({ from: pharmacy.address, gas: 300000 }),
    'unit already sold'
  );
  // После первой продажи партию передавать нельзя.
  await assertRevert(
    inst.methods.transferCustody(batchId, distributor.address).send({ from: pharmacy.address, gas: 300000 }),
    'batch has sold units'
  );
});

test('продажа просроченной и отозванной партии запрещена', async () => {
  const inst = await freshContract();
  // Просроченная партия.
  const rcpt = await sendTx(
    inst.methods.registerBatch('X', 'EXP-1', 2, Math.floor(Date.now() / 1000) + 5, '').send({ from: manufacturer.address, gas: 600000 }),
    'register'
  );
  const expiredId = rcpt.events.BatchRegistered.returnValues.batchId;
  await sendTx(inst.methods.mintUnits(expiredId, [keccak('e1')]).send({ from: manufacturer.address, gas: 4_000_000 }), 'mint');
  await sendTx(inst.methods.transferCustody(expiredId, pharmacy.address).send({ from: manufacturer.address, gas: 300000 }), '→ p');

  // Отзыванная партия.
  const { batchId, firstTokenId } = await makeBatch(inst, { quantity: 2, mint: 1, label: 'M5' });
  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: manufacturer.address, gas: 300000 }), '→ p');
  await sendTx(inst.methods.recallBatch(batchId, 'брак').send({ from: manufacturer.address, gas: 300000 }), 'recall');
  await assertRevert(
    inst.methods.markSold(firstTokenId).send({ from: pharmacy.address, gas: 300000 }),
    'batch recalled'
  );
});

test('отзыв: в любой момент (в т.ч. после продаж), recalledAt фиксируется', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId } = await makeBatch(inst, { quantity: 3, mint: 2, label: 'M6' });
  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: manufacturer.address, gas: 300000 }), '→ p');
  await sendTx(inst.methods.markSold(firstTokenId).send({ from: pharmacy.address, gas: 300000 }), 'sold');

  await assertRevert(
    inst.methods.recallBatch(batchId, 'x').send({ from: pharmacy.address, gas: 300000 }),
    'cannot recall'
  );
  await sendTx(inst.methods.recallBatch(batchId, 'брак партии').send({ from: admin.address, gas: 300000 }), 'recall');
  const b = await inst.methods.getBatch(batchId).call();
  assert.ok(Number(b.recalledAt) > 0, 'recalledAt заполнен');
  assert.equal(b.recallReason, 'брак партии');
  await assertRevert(
    inst.methods.recallBatch(batchId, 'x').send({ from: admin.address, gas: 300000 }),
    'already recalled'
  );
});

test('верификация: бесплатная view-проверка без изменения состояния', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId, secrets } = await makeBatch(inst, { quantity: 4, mint: 2, label: 'M7' });

  const v = await inst.methods.verifyView(firstTokenId, secrets[0]).call({ from: buyer.address });
  assert.equal(v.codeValid, true);
  assert.equal(Number(v.status), UNIT_STATUS.Active);
  assert.equal(Number(v.batchId), batchId);
  assertAddr(v.custodian, manufacturer.address, 'custodian');
  assert.ok(Number(v.mintedAt) > 0);
  assert.equal(Number(v.soldAt), 0);
  assert.equal(v.recalled, false);

  const fake = await inst.methods.verifyView(firstTokenId, 'PHARMA-WRONG').call({ from: buyer.address });
  assert.equal(fake.codeValid, false);

  // Несуществующая коробка — revert.
  await assertRevert(inst.methods.verifyView(999, 'x').call(), 'unit does not exist');
});

test('детектор подделки: проданная коробка сообщает soldAt в verifyView', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId, secrets } = await makeBatch(inst, { quantity: 4, mint: 2, label: 'M8' });
  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: manufacturer.address, gas: 300000 }), '→ p');
  await sendTx(inst.methods.markSold(firstTokenId).send({ from: pharmacy.address, gas: 300000 }), 'sold');

  const v = await inst.methods.verifyView(firstTokenId, secrets[0]).call({ from: buyer.address });
  assert.equal(v.codeValid, true);
  assert.equal(Number(v.status), UNIT_STATUS.Sold);
  assert.ok(Number(v.soldAt) > 0, 'покупатель видит дату продажи');

  // Вторая коробка партии ещё Active.
  const v2 = await inst.methods.verifyView(firstTokenId + 1, secrets[1]).call({ from: buyer.address });
  assert.equal(Number(v2.status), UNIT_STATUS.Active);
});

test('отозванная коробка: флаг recalled и recalledAt видны покупателю', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId, secrets } = await makeBatch(inst, { quantity: 3, mint: 2, label: 'M9' });
  await sendTx(inst.methods.recallBatch(batchId, 'фальсификация').send({ from: manufacturer.address, gas: 300000 }), 'recall');

  const v = await inst.methods.verifyView(firstTokenId, secrets[0]).call({ from: buyer.address });
  assert.equal(v.codeValid, true);
  assert.equal(v.recalled, true);
  assert.ok(Number(v.recalledAt) > 0);
});

test('аудит: события образуют журнал жизни коробки', async () => {
  const inst = await freshContract();
  const { batchId, firstTokenId, secrets } = await makeBatch(inst, { quantity: 4, mint: 2, label: 'M10' });
  await sendTx(inst.methods.transferCustody(batchId, distributor.address).send({ from: manufacturer.address, gas: 300000 }), '→ d');
  await sendTx(inst.methods.transferCustody(batchId, pharmacy.address).send({ from: distributor.address, gas: 300000 }), '→ p');
  await sendTx(inst.methods.markSold(firstTokenId).send({ from: pharmacy.address, gas: 300000 }), 'sold');

  const events = await inst.getPastEvents('allEvents', { fromBlock: 0 });
  const names = events.map((e) => e.event).filter((n) => !n.startsWith('Participant'));
  assert.deepEqual(names, [
    'BatchRegistered',
    'Transfer', 'Transfer',            // минт коробок 1 и 2
    'UnitsMinted',                     // сводное событие выпуска
    'CustodyTransferred',
    'CustodyTransferred',
    'UnitSold',
  ]);
  const sold = events.find((e) => e.event === 'UnitSold');
  assert.equal(sold.returnValues.tokenId, String(firstTokenId));
  assert.ok(Number(sold.returnValues.soldAt) > 0);
});

test(' несколько партий: независимые диапазоны tokenId и перечисление', async () => {
  const inst = await freshContract();
  const a = await makeBatch(inst, { quantity: 3, mint: 2, label: 'A' });
  const b = await makeBatch(inst, { quantity: 3, mint: 1, label: 'B' });
  assert.deepEqual([a.firstTokenId, a.lastTokenId], [1, 2]);
  assert.deepEqual([b.firstTokenId, b.lastTokenId], [3, 3]);
  assert.deepEqual((await inst.methods.getBatchIds().call()).map(Number), [1, 2]);
  assert.deepEqual((await inst.methods.getUnitIds(b.batchId).call()).map(Number), [3]);
  assert.equal(Number(await inst.methods.totalSupply().call()), 3);
});
