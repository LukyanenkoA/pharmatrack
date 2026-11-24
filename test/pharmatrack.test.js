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
