import axios from 'axios';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { 
    getCurrentIP, 
    setupAxiosWithProxy 
} from '../../../../WB_module/network/controller/networkController.js';

// Функция преобразования записи из базы данных в массив
async function extractDataFromRecord(record) {
    let elements = [];
    let currentElement = '';
    let inQuotes = false;

    for (let char of record) {
        if (char === '"') {
            inQuotes = !inQuotes;
        }

        if (char === ':' && !inQuotes) {
            elements.push(currentElement);
            currentElement = '';
        } else {
            currentElement += char;
        }
    }

    if (currentElement) {
        elements.push(currentElement);
    }

    return elements;
}

// Функция получения phoneNumber, phoneModel, token, modelID из массива записи
async function getDataFromElements(elements) {
    const phoneNumber = elements[0];
    const mobileData = elements[16].split('@');
    const phoneModel = mobileData[0].replace(/"/g, '');
    const modelID = mobileData[1].replace(/"/g, '');
    const token = mobileData[2].replace(/"/g, '');

    return {
        phoneNumber,
        phoneModel,
        token,
        modelID
    };
}

// Функция получения заголовков для запроса
async function getRequestHeaders(fingerprintUA, phoneNumber) {
    try {
        return {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, compress, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Sec-Ch-Ua': '"Chromium";v="117", "Not;A=Brand";v="8"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': 'Windows',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Sec-Gpc': '1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': fingerprintUA? fingerprintUA : 'Mozilla/5.0 (Linux; arm_64; Android 10; HRY-LX1T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 YaBrowser/23.5.1.73.00 SA/3 Mobile Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Spa-Version': '9.3.138',
        };
    } catch (error) {
        console.error('Ошибка при получении заголовков запроса с сессией:', error.message);
        await sendErrorToTelegram(`Ошибка при формировании заголовков для номера ${phoneNumber}.`, 'getRequestHeadersWithSession');
        throw error;
    }
}

// Функция получения заголовков для запроса
async function getRootHeaders(devicename, deviceId, token) {
    try {
        return {
            'Accept': '*/*',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://www.wildberries.ru',
            'Wb-AppVersion': '507',
            'Wb-AppType': 'android',
            'devicename': `${devicename}`,
            'deviceId': `${deviceId}`,
            'serviceType': 'null',
            'authtoken': `${token}`,
            'User-Agent': 'Mozilla/5.0 (Linux; arm_64; Android 10; HRY-LX1T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 YaBrowser/23.5.1.73.00 SA/3 Mobile Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
        };
    } catch (error) {
        console.error('Ошибка при получении заголовков запроса с сессией:', error.message);
        await sendErrorToTelegram(`Ошибка при формировании заголовков для номера ${phoneNumber}.`, 'getRequestHeadersWithSession');
        throw error;
    }
}

// Функция настройки экземпляра Axios с прокси
async function setupLikeAxiosInstanceWithProxy(proxyString, phoneNumber) {
    // Получение оригинального IP без прокси
    const originalIP = await getCurrentIP(axios);
    
    const axiosInstance = await setupAxiosWithProxy(proxyString);
    
    // Получение IP после применения прокси
    const currentIP = await getCurrentIP(axiosInstance);
    console.log('IP', originalIP, currentIP);
    if (!currentIP || currentIP === originalIP) {
        console.error("Не удалось настроить axios с прокси или IP не изменился:", proxyString);
        await sendErrorToTelegram(`Ошибка при настройке прокси для номера ${phoneNumber}.`, 'setupBrandAxiosInstanceWithProxy');
        throw new Error("Настройка Axios с прокси не удалась или IP не изменился");
    }

    return axiosInstance;
}

// Функция для получения $.data.products.[0].root
async function getRoot(axiosProxyInstance, article, headers, phoneNumber) {
    try {
        const response = await axiosProxyInstance.request({
            url: `https://www.wildberries.ru/=${article}`,
            method: 'get',
            headers: headers,
        });
        return response.data.data.products[0].root;
    } catch (error) {
        console.error('Ошибка при получении data.products.[0].root:', error.message);
        await sendErrorToTelegram(`Ошибка при получении data.products[0].root для номера ${phoneNumber}.`, 'getRoot');
        return null;
    }
}

// Функция для получения ссылки на все отзывы к товару
async function getCommentsURL(axiosProxyInstance, root, headers, phoneNumber) {
    try {
        const response = await axiosProxyInstance.request({
            url: `https://www.wildberries.ru/?imt=${root}`,
            method: 'get',
            headers: headers,
        });
        return response.data[0];
    } catch (error) {
        console.error(`Ошибка при получении https://www.wildberries.ru/=${root}`, error.message);
        await sendErrorToTelegram(`Ошибка при получении ссылки с data.products[0].root для номера ${phoneNumber}.`, 'getCommentsURL');
        return null;
    }
}

// Функция получения всех отзывов
async function getAllFeedback(axiosProxyInstance, rootURL, headers, feedbackID,  phoneNumber) {
    try {
        const response = await axiosProxyInstance.request({
            url: `${rootURL}`,
            method: 'get',
            headers: headers,
        });
        return response.data.feedbacks;
    } catch (error) {
        console.error(`Ошибка при получении всех отзывов для ссылки ${rootURL}`, error.message);
        await sendErrorToTelegram(`Ошибка при получении всех отзывов для ссылки ${rootURL} для номера ${phoneNumber}.`, 'getAllFeedback');
        return null;
    }
}

// Функция поиска отзыва по ID
async function findFeedbackByID(axiosProxyInstance, rootURL, headers, feedbackID,  phoneNumber) {
    try {
        const response = await axios.request({
            url: `${rootURL}?_=${new Date().getTime()}`,
            method: 'get',
            headers: headers,
        });

        // Ищем отзыв в массиве по ID
        const feedback = response.data.feedbacks.find(feedback => feedback.id === feedbackID);
        if (!feedback) {
            throw new Error(`Отзыв с ID ${feedbackID} не найден.`);
        }
        return feedback;
    } catch (error) {
        console.error('Ошибка в функции findFeedbackByID:', error.message);
        await sendErrorToTelegram(`Ошибка при поиске отзыва с ID ${feedbackID} для номера ${phoneNumber}.`, 'findFeedbackByID');
    }
}

// Функция получения количества лайков или дизлайков отзыва
export async function findActionAmount(feedback, feedbackID, actionType) {
    try {
        let count;

        // На основании actionType определяем какой count вернуть
        if (actionType === 'like') {
            count = await feedback.votes.pluses;
        } else if (actionType === 'dislike') {
            count = await feedback.votes.minuses;
        } else {
            throw new Error(`Неправильное действие "${actionType}" предоставлено.`);
        }

        // Check if the count is not null or undefined
        if (count === undefined || count === null) {
            throw new Error(`Не удалось найти количество ${actionType === 'like' ? 'лайков' : 'дизлайков'} для отзыва с ID ${feedbackID}.`);
        }

        return count;
    } catch (error) {
        console.error(`Ошибка в функции findActionAmount:`, error.message);
        await sendErrorToTelegram(`Ошибка при поиске количества ${actionType === 'like' ? 'лайков' : 'дизлайков'} для отзыва с ID ${feedbackID} для номера ${phoneNumber}.`, 'findActionAmount');
    }
}

// Функция для лайка/дизлайка
async function action(axiosProxyInstance, headers, actionType, feedbackID, phoneNumber) {
    try {
        const vote = actionType === 'like' ? 'true' : 'false';
        
        const response = await axiosProxyInstance.request({
            url: `https://www.wildberries.ru/?vote=${vote}&id=${feedbackID}`,
            method: 'get',
            headers: headers,
        });
        if (response.status === 200 && response.statusText === 'OK') {
            console.log(`Удачно отправен запрос на ${actionType === 'like' ? 'лайк' : 'дизлайк'}.`);
            return true;
        } else {
            console.log(`Не удалось отправить запрос на ${actionType === 'like' ? 'лайк' : 'дизлайк'}.`);
            return false;
        }

    } catch (error) {
        console.error(`Ошибка при ${actionType === 'like' ? 'лайке' : 'дизлайке'}`, error.message);
        await sendErrorToTelegram(`Ошибка отправки запроса при ${actionType === 'like' ? 'лайке' : 'дизлайке'} для отзыва с ID ${feedbackID} для номера ${phoneNumber}.`, 'action');
        return false;
    }
}

// Функция ожидания
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Основная функция действия на комментарий
export async function likeComment(proxyString, article, phoneNumber, actionType, record, feedbackID) {
    try {

        // Параметры для повторного получения updatedActionCount
        const maxAttempts = 5;
        const delay = 180000;
        let attempt = 0;
        let success = false;

        // Установка клиента с прокси
        const client = await setupLikeAxiosInstanceWithProxy(proxyString, phoneNumber);
        if (!client) {
            throw new Error('Не удалось загрузить клиент с прокси.');
        }

        // Извлечение данных из записи
        const data = await extractDataFromRecord(record);
        if (!data || data.length === 0) {
            throw new Error('Ошибка при извлечении данных из записи.');
        }

        // Получение параметров из данных
        const params = await getDataFromElements(data);
        if (!params || !params.phoneModel || !params.modelID || !params.token) {
            throw new Error('Не удалось получить параметры из элементов данных.');
        }

        // Получение заголовков запроса
        const RequestHeaders = await getRequestHeaders(0, phoneNumber);
        if (!RequestHeaders) {
            throw new Error('Не удалось получить заголовки запроса.');
        }

        // Получение корня
        const root = await getRoot(client, article, RequestHeaders, phoneNumber);
        if (!root) {
            throw new Error('Не удалось получить корень.');
        }

        // Получение заголовков для корня
        const rootHeaders = await getRootHeaders(params.phoneModel, params.modelID, params.token);
        if (!rootHeaders) {
            throw new Error('Не удалось получить заголовки для корня.');
        }

        // Получение URL для комментариев
        const rootURL = await getCommentsURL(client, root, RequestHeaders, phoneNumber);
        if (!rootURL) {
            throw new Error('Не удалось получить URL для комментариев.');
        }
        console.log(rootURL);

        // Получение всех отзывов
        const feedback = await findFeedbackByID(client, rootURL, RequestHeaders, feedbackID, phoneNumber);
        if (!feedback) {
            throw new Error('Не удалось получить все отзывы.');
        }
        console.log(feedback);

        // Находим количество лайков/дизлайков
        const initialActionCount = await findActionAmount(feedback, feedbackID, actionType);
        if (initialActionCount === undefined || initialActionCount === null) {
            throw new Error(`Не удалось получить количество ${actionType === 'like' ? 'лайков' : 'дизлайков'}.`);
        }
        console.log(`${actionType === 'like' ? 'Лайков' : 'Дизлайков'} было:`, initialActionCount);

        // Выполнение действия лайк/дизлайк
        const actionSuccess = await action(client, rootHeaders, actionType, feedbackID, phoneNumber);

        if (actionSuccess) {
            console.log(`Успешный ${actionType === 'like' ? 'лайк' : 'дизлайк'} отзыва ${feedbackID} для товара ${article} для номера ${phoneNumber}`);
            return true;
        } else {
            console.log(`Не удалось выполнить действие ${actionType === 'like' ? 'лайк' : 'дизлайк'} для отзыва ${feedbackID}`);
            return false;
        }

    } catch (error) {
        console.error('Ошибка в основной функции:', error.message);
        await sendErrorToTelegram(`Ошибка в основной функции действия на отзыв ${feedbackID} для номера телефона ${phoneNumber}: ${error.message}`, 'main');
        return false;
    }
}

await likeComment(proxyString, article, phoneNumber, actionType, record, feedbackID);