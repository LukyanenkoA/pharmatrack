// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PharmaTrack — сериализация упаковок лекарств на Ethereum
 * @notice Учебный проект курса «Блокчейн». Противодействие поддельным
 *         лекарствам: учёт на уровне отдельной упаковки (коробки).
 *
 * Модель данных:
 *   Партия (Batch) — группировка: название, серийник, срок годности,
 *                   заявленное количество, текущий владелец (custodian).
 *   Упаковка (Unit) — уникальный токен (упрощённый ERC-721): tokenId,
 *                   свой QR-секрет (в контракте — только keccak256-хэш),
 *                   статус Active/Sold, mintedAt/soldAt.
 *
 * Жизненный цикл:
 *   registerBatch → mintUnits (по токену на коробку)
 *   transferCustody: Производитель → Дистрибьютор → Аптека (партией)
 *   markSold(tokenId): продажа коробки — необратима, фиксирует soldAt
 *   recallBatch: отзыв партии в любой момент (в т.ч. после продаж)
 *
 * Детектор подделки: покупатель бесплатно вызывает verifyView(tokenId,
 * secret). «Новая» коробка с tokenId, который уже числится проданным
 * (soldAt), — копия. Счётчик сканирований не используется: покупатель
 * ничего не пишет в блокчейн и не платит газ.
 *
 * Упрощённый профиль ERC-721: ownerOf, totalSupply, событие Transfer
 * при выпуске. approve/safeTransferFrom отсутствуют сознательно:
 * передачи возможны только через transferCustody с проверкой ролей.
 */
contract PharmaTrack {
    // ---------- Типы ----------

    /// @notice Роль участника сети цепочки поставок.
    enum Role {
        None,         // 0 — не участник
        Admin,        // 1 — администратор реестра
        Manufacturer, // 2 — производитель
        Distributor,  // 3 — дистрибьютор / перевозчик
        Pharmacy      // 4 — аптека
    }

    /// @notice Статус упаковки. Отзыв — атрибут партии (см. Batch.recalledAt).
    enum UnitStatus {
        Active, // 0 — в обороте
        Sold    // 1 — продана покупателю (необратимо)
    }

    /// @notice Партия лекарств — группировка упаковок.
    struct Batch {
        uint256 id;            // идентификатор партии (с 1)
        string name;           // название препарата
        string serialNumber;   // серийный номер партии
        uint256 quantity;      // заявленное количество упаковок
        uint256 mintedCount;   // сколько упаковок уже выпущено
        uint256 soldCount;     // сколько упаковок продано (блокирует передачу)
        uint64 expiry;         // срок годности, unix timestamp
        address manufacturer;  // производитель
        address custodian;     // текущий владелец партии
        uint64 createdAt;      // время регистрации
        uint64 recalledAt;     // время отзыва (0 — не отозвана)
        string recallReason;   // причина отзыва
        string instructionsUrl;// ссылка на инструкцию препарата
    }

    /// @notice Упаковка (коробка) — единица сериализации.
    struct Unit {
        uint256 batchId;   // партия, к которой относится упаковка
        UnitStatus status; // Active / Sold
        bytes32 codeHash;  // keccak256(QR-секрета); сам секрет в блокчейн не попадает
        uint64 mintedAt;   // время выпуска упаковки
        uint64 soldAt;     // время продажи (0 — не продана)
    }

    // ---------- Хранилище ----------

    /// @notice Адрес администратора (деплоер контракта).
    address public admin;

    /// @notice Участники цепочки поставок и их роли.
    mapping(address => Role) public participants;

    /// @notice Реестр партий: id => партия.
    mapping(uint256 => Batch) public batches;

    /// @notice Реестр упаковок: tokenId => упаковка.
    mapping(uint256 => Unit) public units;

    /// @notice Идентификаторы выпущенных упаковок каждой партии.
    mapping(uint256 => uint256[]) private _unitIds;

    /// @notice Все идентификаторы партий (для перечисления в UI).
    uint256[] private _batchIds;

    /// @notice Счётчик идентификаторов партий.
    uint256 public nextBatchId = 1;

    /// @notice Счётчик tokenId упаковок (глобальный, с 1).
    uint256 public nextUnitId = 1;

    // ---------- События (неизменяемый журнал аудита) ----------

    event ParticipantAdded(address indexed participant, Role role);
    event ParticipantRemoved(address indexed participant);
    event BatchRegistered(
        uint256 indexed batchId,
        string name,
        string serialNumber,
        address indexed manufacturer,
        uint256 quantity,
        uint64 expiry
    );
    event UnitsMinted(uint256 indexed batchId, uint256 firstTokenId, uint256 lastTokenId, address indexed manufacturer);
    event CustodyTransferred(uint256 indexed batchId, address indexed from, address indexed to);
    event UnitSold(uint256 indexed tokenId, address indexed pharmacy, uint64 soldAt);
    event BatchRecalled(uint256 indexed batchId, string reason, uint64 recalledAt);

    /// @notice ERC-721: выпуск упаковки в обращение (from = 0x0).
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    // ---------- Модификаторы ----------

    modifier onlyAdmin() {
        require(participants[msg.sender] == Role.Admin, "PharmaTrack: caller is not admin");
        _;
    }

    modifier onlyRole(Role role) {
        require(participants[msg.sender] == role, "PharmaTrack: caller has wrong role");
        _;
    }

    modifier batchExists(uint256 batchId) {
        require(batches[batchId].id != 0, "PharmaTrack: batch does not exist");
        _;
    }

    modifier unitExists(uint256 tokenId) {
        require(units[tokenId].batchId != 0, "PharmaTrack: unit does not exist");
        _;
    }

    // ---------- Управление участниками ----------

    constructor() {
        admin = msg.sender;
        participants[msg.sender] = Role.Admin;
        emit ParticipantAdded(msg.sender, Role.Admin);
    }

    /**
     * @notice Выдать адресу роль участника цепочки поставок. Только админ.
     */
    function addParticipant(address participant, Role role) external onlyAdmin {
        require(participant != address(0), "PharmaTrack: zero address");
        require(role != Role.None, "PharmaTrack: role cannot be None");
        require(participants[participant] == Role.None, "PharmaTrack: already a participant");
        participants[participant] = role;
        emit ParticipantAdded(participant, role);
    }

    /**
     * @notice Лишить адрес роли участника. Только админ.
     */
    function removeParticipant(address participant) external onlyAdmin {
        require(participants[participant] != Role.None, "PharmaTrack: not a participant");
        participants[participant] = Role.None;
        emit ParticipantRemoved(participant);
    }

    // ---------- Выпуск партии и упаковок ----------

    /**
     * @notice Зарегистрировать партию (без выпуска упаковок). Только
     *         производитель. Упаковки выпускаются отдельно вызовом mintUnits.
     * @param name            название препарата
     * @param serialNumber    серийный номер партии
     * @param quantity        заявленное количество упаковок в партии
     * @param expiry          срок годности (unix timestamp)
     * @param instructionsUrl ссылка на инструкцию (может быть пустой)
     * @return batchId идентификатор партии
     */
    function registerBatch(
        string calldata name,
        string calldata serialNumber,
        uint256 quantity,
        uint64 expiry,
        string calldata instructionsUrl
    ) external onlyRole(Role.Manufacturer) returns (uint256 batchId) {
        require(bytes(name).length > 0, "PharmaTrack: name is empty");
        require(bytes(serialNumber).length > 0, "PharmaTrack: serial is empty");
        require(quantity > 0, "PharmaTrack: quantity is zero");
        require(expiry > block.timestamp, "PharmaTrack: already expired");

        batchId = nextBatchId++;
        batches[batchId] = Batch({
            id: batchId,
            name: name,
            serialNumber: serialNumber,
            quantity: quantity,
            mintedCount: 0,
            soldCount: 0,
            expiry: expiry,
            manufacturer: msg.sender,
            custodian: msg.sender,
            createdAt: uint64(block.timestamp),
            recalledAt: 0,
            recallReason: "",
            instructionsUrl: instructionsUrl
        });
        _batchIds.push(batchId);

        emit BatchRegistered(batchId, name, serialNumber, msg.sender, quantity, expiry);
    }

    /**
     * @notice Выпустить упаковки партии: по одному токену на коробку,
     *         у каждой свой QR-секрет (в контракт передаются только хэши).
     *         Только производитель партии. Выпускать следует чанками:
     *         одна коробка ≈ 80–100 тыс. газа, лимит блока ~30 млн.
     * @param batchId   идентификатор партии
     * @param codeHashes keccak256 секретов каждой выпускаемой коробки
     * @return firstTokenId первый выпущенный tokenId диапазона
     * @return lastTokenId последний выпущенный tokenId диапазона
     */
    function mintUnits(uint256 batchId, bytes32[] calldata codeHashes)
        external
        batchExists(batchId)
        returns (uint256 firstTokenId, uint256 lastTokenId)
    {
        Batch storage batch = batches[batchId];
        require(msg.sender == batch.manufacturer, "PharmaTrack: not batch manufacturer");
        require(batch.recalledAt == 0, "PharmaTrack: batch recalled");
        require(codeHashes.length > 0, "PharmaTrack: empty list");
        require(codeHashes.length <= 250, "PharmaTrack: mint in smaller chunks");
        require(batch.mintedCount + codeHashes.length <= batch.quantity,
            "PharmaTrack: exceeds declared quantity");

        firstTokenId = nextUnitId;
        for (uint256 i = 0; i < codeHashes.length; i++) {
            require(codeHashes[i] != bytes32(0), "PharmaTrack: zero code hash");
            uint256 tokenId = nextUnitId++;
            units[tokenId] = Unit({
                batchId: batchId,
                status: UnitStatus.Active,
                codeHash: codeHashes[i],
                mintedAt: uint64(block.timestamp),
                soldAt: 0
            });
            _unitIds[batchId].push(tokenId);
            emit Transfer(address(0), batch.custodian, tokenId); // ERC-721: минт
        }
        batch.mintedCount += codeHashes.length;
        lastTokenId = nextUnitId - 1;

        emit UnitsMinted(batchId, firstTokenId, lastTokenId, msg.sender);
    }
}
