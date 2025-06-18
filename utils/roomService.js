import { logMessage } from './logger.js';
import { bitrixClient } from './bitrix.js';
import { log } from 'console';

class RoomService {
    constructor() {
        this.roomTypes = {
            UF_CRM_DEAL_1750132990506: {
                basePrice: 5000, // Базовая цена за стандартный номер
                occupancyMultiplier: 1.2 // Множитель при занятости
            },
            UF_CRM_DEAL_1750133047593: {
                basePrice: 10000, // Базовая цена за люкс
                occupancyMultiplier: 1.3 // Множитель при занятости
            }
        };
    }

    // Получение списка категорий номеров
    async getRoomCategories() {
        try {
            const categories = await bitrixClient.getRoomCategories();
            if (!categories || !categories.result) {
                throw new Error('Invalid categories response');
            }
            return categories.result;
        } catch (error) {
            throw new Error(`Failed to fetch room categories: ${error.message}`);
        }
    }

    // Получение занятых дат для определенного типа номера
    async getOccupiedDates(roomId, roomType, checkIn, checkOut) {
        try {
            if (!roomId || !roomType || !checkIn || !checkOut) {
                throw new Error('Missing required parameters');
            }

            const checkInDate = new Date(checkIn);
            const checkOutDate = new Date(checkOut);
            const year = checkInDate.getFullYear();
            const month = checkInDate.getMonth() + 1;

            // Get deals for the month
            const dealsData = await bitrixClient.getDealsByMonth(year, month, roomType);
            
            // Get deals for the specific room type
            const roomTypeData = dealsData[roomType];
            if (!roomTypeData || !roomTypeData.deals) {
                return [];
            }

            // Filter deals for the specific room
            const roomDeals = roomTypeData.deals.filter(deal => {
                // Проверяем, что сделка относится к нужному номеру
                const dealRoomId = deal[roomType]; // ID номера в сделке
                return dealRoomId === roomId;
            });

            // Check for overlapping dates
            return roomDeals.filter(deal => {
                const dealCheckIn = new Date(deal.UF_CRM_1749509439624); // Дата заезда
                const dealCheckOut = new Date(deal.UF_CRM_1749787453685); // Дата выезда
                
                return (
                    (checkInDate >= dealCheckIn && checkInDate < dealCheckOut) ||
                    (checkOutDate > dealCheckIn && checkOutDate <= dealCheckOut) ||
                    (checkInDate <= dealCheckIn && checkOutDate >= dealCheckOut)
                );
            });
        } catch (error) {
            console.error('Error getting occupied dates:', error);
            throw error;
        }
    }

    // Проверка доступности номера на определенные даты
    async checkAvailability(roomId, roomType, checkIn, checkOut) {
        try {
            if (!roomType || !checkIn || !checkOut) {
                throw new Error('Missing required parameters');
            }

            const checkInDate = new Date(checkIn);
            const checkOutDate = new Date(checkOut);
            const year = checkInDate.getFullYear();
            const month = checkInDate.getMonth() + 1;

            const deals = await bitrixClient.getDealsByMonth(year, month, roomType);
            if (!deals || !deals[roomType]) {
                throw new Error('Invalid deals response or category not found');
            }
            const categoryDeals = deals[roomType].deals;

            // Если указан конкретный roomId – проверяем только его
            const roomsToCheck = [];
            if (roomId) {
                roomsToCheck.push(roomId);
            } else {
                // Получаем список всех комнат этой категории
                const roomsList = await bitrixClient.getRoomsFromFields(roomType);
                roomsToCheck.push(...Object.keys(roomsList));
            }

            for (const rId of roomsToCheck) {
                let isFree = true;
                for (const deal of categoryDeals) {
                    if (!deal.UF_CRM_1749509439624 || !deal.UF_CRM_1749787453685) continue;
                    const dealRoomId = deal[roomType];
                    if (dealRoomId !== rId) continue;

                    const dealCheckIn = new Date(deal.UF_CRM_1749509439624);
                    const dealCheckOut = new Date(deal.UF_CRM_1749787453685);

                    const overlap = (
                        (checkInDate >= dealCheckIn && checkInDate < dealCheckOut) ||
                        (checkOutDate > dealCheckIn && checkOutDate <= dealCheckOut) ||
                        (checkInDate <= dealCheckIn && checkOutDate >= dealCheckOut)
                    );
                    if (overlap) {
                        isFree = false;
                        break;
                    }
                }

                if (isFree) {
                    return { available: true, roomId: rId };
                }
            }

            return { available: false };
        } catch (error) {
            logMessage('ERROR', 'RoomService.checkAvailability', error);
            throw error;
        }
    }

    // Расчет стоимости номера
    async calculatePrice(roomId, roomType, checkIn, checkOut) {
        try {
            if (!roomType || !this.roomTypes[roomType]) {
                throw new Error('Invalid room type');
            }

            if (!checkIn || !checkOut) {
                throw new Error('Check-in and check-out dates are required');
            }

            const checkInDate = new Date(checkIn);
            const checkOutDate = new Date(checkOut);

            if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
                throw new Error('Invalid date format');
            }

            if (checkInDate >= checkOutDate) {
                throw new Error('Check-out date must be after check-in date');
            }

            const roomConfig = this.roomTypes[roomType];
            
            // Получаем все месяцы между датами заезда и выезда
            const months = [];
            let currentDate = new Date(checkInDate);
            while (currentDate <= checkOutDate) {
                const year = currentDate.getFullYear();
                const month = currentDate.getMonth() + 1;
                months.push({ year, month });
                currentDate.setMonth(currentDate.getMonth() + 1);
            }

            // Получаем занятые даты для каждого месяца
            const occupiedDates = [];
            for (const { year, month } of months) {
                const monthOccupiedDates = await this.getOccupiedDates(roomId, roomType, checkIn, checkOut);
                occupiedDates.push(...monthOccupiedDates);
            }
            
            const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
            let totalPrice = 0;
            
            for (let i = 0; i < nights; i++) {
                const currentDate = new Date(checkInDate);
                currentDate.setDate(currentDate.getDate() + i);
                
                const isOccupied = occupiedDates.some(booking => {
                    const bookingCheckIn = new Date(booking.checkIn);
                    const bookingCheckOut = new Date(booking.checkOut);
                    return currentDate >= bookingCheckIn && currentDate < bookingCheckOut;
                });
                
                const dailyPrice = isOccupied 
                    ? roomConfig.basePrice * roomConfig.occupancyMultiplier 
                    : roomConfig.basePrice;
                    
                totalPrice += dailyPrice;
            }
            
            return totalPrice;
        } catch (error) {
            throw new Error(`Failed to calculate price: ${error.message}`);
        }
    }

    // Получение информации о номерах
    async getRoomsInfo(year, month, categoryField) {
        try {
            // Получаем список комнат из полей сделки
            const roomsList = await bitrixClient.getRoomsFromFields(categoryField);
            console.log("Rooms from fields:", roomsList);

            // Получаем сделки (бронирования) для месяца
            const deals = await bitrixClient.getDealsByMonth(year, month, categoryField);
            console.log("getRoomsInfo deals:", deals);
            
            if (!deals || !deals[categoryField]) {
                throw new Error('Invalid deals response or category not found');
            }

            const categoryDeals = deals[categoryField].deals;
            const roomsInfo = {};

            // Инициализируем все номера из списка полей
            Object.entries(roomsList).forEach(([id, name]) => {
                roomsInfo[id] = {
                    id,
                    number: name,
                    categoryField,
                    occupiedDates: []
                };
            });

            // Добавляем информацию о занятости из сделок
            categoryDeals.forEach(deal => {
                if (!deal.UF_CRM_1749509439624 || !deal.UF_CRM_1749787453685) return;
                
                // Получаем ID номера из сделки по полю категории
                const roomId = deal[categoryField];
                if (roomId && roomsInfo[roomId]) {
                    roomsInfo[roomId].occupiedDates.push({
                        deal_id: deal.ID,
                        checkIn: deal.UF_CRM_1749509439624,
                        checkOut: deal.UF_CRM_1749787453685,
                        comments: deal.COMMENTS || ''
                    });
                }
            });
            
            
            return {
                rooms: Object.values(roomsInfo)
            };
        } catch (error) {
            logMessage('ERROR', 'RoomService.getRoomsInfo', error);
            throw error;
        }
    }
}

export const roomService = new RoomService(); 