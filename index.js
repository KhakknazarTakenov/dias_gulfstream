import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import bodyParser from "body-parser";
import fs from 'fs';

import { logMessage } from "./utils/logger.js";
import { encryptText, decryptText, generateCryptoKeyAndIV } from "./utils/crypto.js";
import { roomService } from "./utils/roomService.js";
import { bitrixClient } from "./utils/bitrix.js";

import './global.js'
import { log } from 'console';

const envPath = path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

const BASE_URL = "/dias_gulfstream_back/";
const PORT = 4671;

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Статические файлы
app.use(BASE_URL + 'static', express.static(path.join(process.cwd(), 'static')));

// Получить список изображений категории
app.get(BASE_URL + 'images/', async (req, res) => {
    try {
        const { folder } = req.query;
        if (!folder) {
            return res.status(400).json({ status: false, message: 'folder param required' });
        }
        const dirPath = path.join(process.cwd(), 'static', 'images', folder);
        if (!fs.existsSync(dirPath)) {
            return res.status(404).json({ status: false, message: 'Folder not found' });
        }
        const files = fs.readdirSync(dirPath).filter(f => /\.(jpg|jpeg|png|gif|webp|dng)$/i.test(f));
        // const hostPrefix = 'https://storerobots.gamechanger.kz';
        const hostPrefix = 'http://localhost:4671';
        const urls = files.map(f => `${hostPrefix}${BASE_URL}static/images/${folder}/${f}`);
        res.json({ status: true, images: urls });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});

// Инициализация системы
app.post(BASE_URL + "init/", async (req, res) => {
    try {
        const bxLink = req.body.bx_link;
        if (!bxLink) {
            res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить ссылку входящего вебхука!"
            });
            return;
        }

        const keyIv = generateCryptoKeyAndIV();
        const bxLinkEncrypted = await encryptText(bxLink, keyIv.CRYPTO_KEY, keyIv.CRYPTO_IV);

        const bxLinkEncryptedBase64 = Buffer.from(bxLinkEncrypted, 'hex').toString('base64');

        const envPath = path.resolve(process.cwd(), '.env');
        const envContent = `CRYPTO_KEY=${keyIv.CRYPTO_KEY}\nCRYPTO_IV=${keyIv.CRYPTO_IV}\nBX_LINK=${bxLinkEncryptedBase64}\n`;

        fs.writeFileSync(envPath, envContent, 'utf8');

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Система готова работать с вашим битриксом!",
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "init", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

// Получение информации о номерах
app.get(BASE_URL + "rooms/", async (req, res) => {
    try {
        const { year, month, category } = req.query;
        
        if (!year || !month) {
            res.status(400).json({
                status: false,
                status_msg: "error",
                message: "Year and month parameters are required"
            });
            return;
        }

        if (!category) {
            res.status(400).json({
                status: false,
                status_msg: "error",
                message: "Category field (UF_CRM) is required"
            });
            return;
        }

        const roomsInfo = await roomService.getRoomsInfo(parseInt(year), parseInt(month), category);
        res.status(200).json({
            status: true,
            status_msg: "success",
            data: roomsInfo
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "rooms", error);
        res.status(500).json({
            status: false,
            status_msg: "error",
            message: "Failed to fetch rooms information"
        });
    }
});

// Проверка доступности номера
app.post(BASE_URL + "rooms/check-availability", async (req, res) => {
    try {
        const { roomId = null, roomType, checkIn, checkOut } = req.body;
        if (!roomType || !checkIn || !checkOut) {
            return res.status(400).json({
                status: false,
                status_msg: "error",
                message: "Missing required parameters"
            });
        }

        const availability = await roomService.checkAvailability(roomId, roomType, checkIn, checkOut);

        // Получаем занятость для дат
        const checkInDate = new Date(checkIn);
        const year = checkInDate.getFullYear();
        const month = checkInDate.getMonth() + 1;
        const occupancy = await roomService.calculateOccupancy(roomType, checkIn, checkOut);

        res.status(200).json({
            status: true,
            status_msg: "success",
            data: {
                available: availability.available,
                roomId: availability.roomId || null,
                occupancy // { "YYYY-MM-DD": <percent> }
            }
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "rooms/check-availability", error);
        res.status(500).json({
            status: false,
            status_msg: "error",
            message: "Failed to check room availability"
        });
    }
});

// Создание бронирования
app.post(BASE_URL + 'booking/create', async (req, res) => {
    try {
        const { roomId, roomType, checkIn, checkOut, contactName, contactPhone, comments } = req.body;

        // Валидация обязательных полей
        if (!roomId || !roomType || !checkIn || !checkOut || !contactName || !contactPhone) {
            return res.json({
                status: false,
                message: 'Не все обязательные поля заполнены'
            });
        }

        // Проверка доступности номера
        const isAvailable = await roomService.checkAvailability(roomId, roomType, checkIn, checkOut);
        if (!isAvailable) {
            return res.json({
                status: false,
                message: 'Номер занят на выбранные даты'
            });
        }

        // Поиск существующего контакта
        const contactResult = await bitrixClient.makeRequest('crm.contact.list', {
            filter: {
                PHONE: contactPhone
            }
        });

        let contactId;
        if (contactResult.result && contactResult.result.length > 0) {
            contactId = contactResult.result[0].ID;
        } else {
            // Создание нового контакта
            const newContactResult = await bitrixClient.makeRequest('crm.contact.add', {
                fields: {
                    NAME: contactName,
                    PHONE: [{ VALUE: contactPhone, VALUE_TYPE: 'WORK' }]
                }
            });

            if (!newContactResult.result) {
                throw new Error('Failed to create contact');
            }

            contactId = newContactResult.result;
        }

        // Создание бронирования
        const bookingResult = await bitrixClient.createBooking({
            roomId,
            roomType,
            checkIn,
            checkOut,
            contactId,
            comments
        });

        if (!bookingResult.result) {
            logMessage(LOG_TYPES.E, BASE_URL + 'booking/create', bookingResult);
            return res.json({
                status: false,
                message: bookingResult.message || 'Ошибка при создании бронирования'
            });
        }

        res.json({
            status: true,
            message: 'Бронирование успешно создано',
            data: {
                bookingId: bookingResult.data,
                contactId: contactId
            }
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.json({
            status: false,
            message: error.message || 'Внутренняя ошибка сервера'
        });
    }
});

app.listen(PORT, () => {
    console.log(`App is running on port ${PORT}`)
})