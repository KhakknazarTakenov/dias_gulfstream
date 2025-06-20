import { decryptText } from './crypto.js';
import { logMessage } from './logger.js';
import path from 'path';
import dotenv from 'dotenv';
import { log } from 'console';

const envPath = path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

class BitrixClient {
    constructor() {
        this.baseUrl = process.env.BX_LINK;
        this.cryptoKey = process.env.CRYPTO_KEY;
        this.cryptoIV = process.env.CRYPTO_IV;

        // Проверяем наличие необходимых переменных окружения
        if (!this.baseUrl || !this.cryptoKey || !this.cryptoIV) {
            throw new Error('Missing required environment variables: BX_LINK, CRYPTO_KEY, or CRYPTO_IV');
        }
    }

    async makeRequest(method, params = {}) {
        try {
            if (!method) {
                throw new Error('Method is required');
            }

            const decryptedUrl = await decryptText(
                this.baseUrl,
                this.cryptoKey,
                this.cryptoIV
            );

            // Преобразуем параметры в URL-строку
            const queryParams = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                if (typeof value === 'object') {
                    // Для вложенных объектов (например, fields)
                    for (const [fieldKey, fieldValue] of Object.entries(value)) {
                        queryParams.append(`${key}[${fieldKey}]`, fieldValue);
                    }
                } else {
                    queryParams.append(key, value);
                }
            }

            const url = `${decryptedUrl}${method}?${queryParams.toString()}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (data.error) {
                throw new Error(`Bitrix API error: ${data.error}`);
            }

            return data;
        } catch (error) {
            logMessage('ERROR', 'BitrixClient.makeRequest', error);
            throw error;
        }
    }

    // Получение списка категорий номеров
    async getRoomCategories() {
        return {
            result: [
                {
                    NAME: 'Стандарт'
                },
                {
                    NAME: 'Люкс'
                }
            ]
        };
    }

    // Получение полей сделки
    async getDealFields() {
        try {
            const response = await this.makeRequest('crm.deal.fields');
            if (!response.result) {
                throw new Error('Failed to get deal fields');
            }

            return response.result;
        } catch (error) {
            logMessage('ERROR', 'BitrixClient.getDealFields', error);
            throw error;
        }
    }

    // Получение списка комнат из полей сделки по категории
    async getRoomsFromFields(categoryField) {
        try {
            if (!categoryField) {
                throw new Error('Category field is required');
            }

            const fields = await this.getDealFields();
            
            // Ищем поле с указанным categoryField
            const categoryFieldData = fields[categoryField];
            if (!categoryFieldData) {
                throw new Error(`Field ${categoryField} not found in deal fields`);
            }

            // Проверяем, что это поле типа list (список)
            if (categoryFieldData.type !== 'enumeration') {
                throw new Error(`Field ${categoryField} is not a list type`);
            }

            // Получаем список значений для этого поля
            const listResponse = await this.makeRequest('crm.deal.userfield.list', {
                filter: {
                    FIELD_NAME: categoryField
                }
            });

            if (!listResponse.result || !listResponse.result.length) {
                throw new Error(`No list values found for field ${categoryField}`);
            }

            const fieldData = listResponse.result[0];
            if (!fieldData.LIST || !fieldData.LIST.length) {
                throw new Error(`No list items found for field ${categoryField}`);
            }

            // Формируем список комнат
            const rooms = {};
            fieldData.LIST.forEach(item => {
                rooms[item.ID] = item.VALUE;
            });

            return rooms;
        } catch (error) {
            logMessage('ERROR', 'BitrixClient.getRoomsFromFields', error);
            throw error;
        }
    }

    // Получение списка сделок (бронирований) с фильтрацией по месяцу
    async getDealsByMonth(year, month, categoryField = null) {
        try {
            const startDate = new Date(year, month - 1, 1);
            const endDate = new Date(year, month, 0);

            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            const decryptedUrl = await decryptText(
                this.baseUrl,
                this.cryptoKey,
                this.cryptoIV
            );

            let commands = {};
            
            if (categoryField) {
                // Если передана конкретная категория, делаем запрос только для неё
                commands = {
                    category: `crm.deal.list?filter[>=UF_CRM_1749509439624]=${startDateStr}&filter[<=UF_CRM_1749787453685]=${endDateStr}&select[]=ID&select[]=UF_CRM_1749509439624&select[]=UF_CRM_1749787453685&select[]=${categoryField}&select[]=COMMENTS`
                };
            } else {
                // Если категория не передана, делаем запрос для всех категорий
                commands = {
                    standard: `crm.deal.list?filter[>=UF_CRM_1749509439624]=${startDateStr}&filter[<=UF_CRM_1749787453685]=${endDateStr}&select[]=ID&select[]=UF_CRM_1749509439624&select[]=UF_CRM_1749787453685&select[]=UF_CRM_DEAL_1750132990506&select[]=COMMENTS`,
                    lux: `crm.deal.list?filter[>=UF_CRM_1749509439624]=${startDateStr}&filter[<=UF_CRM_1749787453685]=${endDateStr}&select[]=ID&select[]=UF_CRM_1749509439624&select[]=UF_CRM_1749787453685&select[]=UF_CRM_DEAL_1750133047593&select[]=COMMENTS`
                };
            }

            // Формируем URL с параметрами
            const queryParams = new URLSearchParams();
            queryParams.append('halt', '0');
            for (const [key, value] of Object.entries(commands)) {
                queryParams.append(`cmd[${key}]`, value);
            }

            const url = `${decryptedUrl}batch?${queryParams.toString()}`;

            const httpResponse = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!httpResponse.ok) {
                throw new Error(`HTTP error! status: ${httpResponse.status}`);
            }

            const data = await httpResponse.json();

            if (data.error) {
                throw new Error(`Batch request failed: ${data.error}`);
            }

            if (!data.result || !data.result.result) {
                throw new Error('Invalid batch response format');
            }

            // Проверяем наличие ошибок в ответе
            if (data.result.result_error && data.result.result_error.length > 0) {
                throw new Error(`Batch request errors: ${JSON.stringify(data.result.result_error)}`);
            }

            // Получаем данные из вложенного result
            const result = data.result.result;

            // Формируем результат
            if (categoryField) {
                // Если запрашивалась конкретная категория, возвращаем данные для неё
                return {
                    [categoryField]: {
                        deals: result.category || []
                    }
                };
            } else {
                // Если запрашивались все категории, возвращаем для всех
                const categoryResults = {};
                for (const [category, deals] of Object.entries(result)) {
                    categoryResults[category === 'standard' ? 'UF_CRM_DEAL_1750132990506' : 'UF_CRM_DEAL_1750133047593'] = {
                        rooms: {},
                        deals: deals
                    };
                } 
                return categoryResults;
            }
        } catch (error) {
            logMessage('ERROR', 'BitrixClient.getDealsByMonth', error);
            throw error;
        }
    }

    // Получение контакта
    async getContact(contactId) {
        if (!contactId) {
            throw new Error('Contact ID is required');
        }

        return this.makeRequest('crm.contact.get', {
            id: contactId,
            select: ['NAME', 'LAST_NAME', 'PHONE']
        });
    }

    // Создание бронирования
    async createBooking(bookingData) {
        if (!bookingData) {
            throw new Error('Booking data is required');
        }

        const { checkIn, checkOut, roomId, roomType, comments, contactId, totalCost } = bookingData;

        if (!checkIn || !checkOut || !roomId || !contactId || !roomType) {
            throw new Error('Missing required booking data: checkIn, checkOut, roomId, roomType, or contactId');
        }

        // Получаем данные о номерах для получения названия
        const roomsList = await this.getRoomsFromFields(roomType);
        const roomName = roomsList[roomId] || roomId;

        const params = {
            fields: {
                TITLE: `Бронь на номер ${roomName} дата заезда ${checkIn}`,
                CATEGORY_ID: 0, // ID воронки
                UF_CRM_1749509439624: checkIn, // Дата заезда
                UF_CRM_1749787453685: checkOut, // Дата выезда
                [roomType]: roomId, // ID номера
                COMMENTS: comments || '',
                CONTACT_ID: contactId,
                OPPORTUNITY: totalCost || 0 // Стоимость бронирования
            }
        };

        const result = await this.makeRequest('crm.deal.add', params);

        if (!result.result) {
            throw new Error('Failed to create booking');
        }

        return {
            result: true,
            data: result.result
        };
    }
}

export const bitrixClient = new BitrixClient(); 