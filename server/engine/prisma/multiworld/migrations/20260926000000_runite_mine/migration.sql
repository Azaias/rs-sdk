-- DropTable
DROP TABLE `koth_capture`;

-- CreateTable
CREATE TABLE `runite_mine` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timestamp` DATETIME(3) NOT NULL,
    `profile` VARCHAR(191) NOT NULL DEFAULT 'main',
    `username` VARCHAR(191) NOT NULL,

    INDEX `runite_mine_timestamp_idx`(`timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

