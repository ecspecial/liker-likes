import axios from 'axios';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { 
    getCurrentIP, 
    setupAxiosWithProxy 
} from '../../../../WB_module/network/controller/networkController.js';

// Функция настройки экземпляра Axios с прокси
async function setupLikeAxiosInstanceWithProxy(proxyString) {
    // Получение оригинального IP без прокси
    const originalIP = await getCurrentIP(axios);
    
    const axiosInstance = await setupAxiosWithProxy(proxyString);
    
    // Получение IP после применения прокси
    const currentIP = await getCurrentIP(axiosInstance);
    console.log('IP', originalIP, currentIP);
    if (!currentIP || currentIP === originalIP) {
        console.error("Не удалось настроить axios с прокси или IP не изменился:", proxyString);
        await sendErrorToTelegram(`Ошибка при настройке прокси для проверки числа действий на отзыве.`, 'setupBrandAxiosInstanceWithProxy');
        throw new Error("Настройка Axios с прокси не удалась или IP не изменился");
    }

    return axiosInstance;
}

// Функция получения заголовков для запроса
async function getRequestHeaders() {
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
            'User-Agent': 'Mozilla/5.0 (Linux; arm_64; Android 10; HRY-LX1T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 YaBrowser/23.5.1.73.00 SA/3 Mobile Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Spa-Version': '9.3.138',
        };
    } catch (error) {
        console.error('Ошибка при получении заголовков запроса с сессией:', error.message);
        await sendErrorToTelegram(`Ошибка при формировании заголовков для проверки числа действий на отзыве.`, 'getRequestHeadersWithSession');
        throw error;
    }
}


// Функция для получения $.data.products.[0].root
async function getRoot(article, headers) {
    try {
        const response = await axios.request({
            url: `https://www.wildberries.ru/=${article}`,
            method: 'get',
            headers: headers,
        });
        return response.data.data.products[0].root;
    } catch (error) {
        console.error('Ошибка при получении data.products.[0].root:', error.message);
        await sendErrorToTelegram(`Ошибка при получении data.products[0].root для проверки числа действий на отзыве.`, 'getRoot');
        return null;
    }
}

// Функция для получения ссылки на все отзывы к товару
async function getCommentsURL(root, headers) {
    try {
        const response = await axios.request({
            url: `https://www.wildberries.ru/=${root}`,
            method: 'get',
            headers: headers,
        });
        return response.data[0];
    } catch (error) {
        console.error(`Ошибка при получении https://www.wildberries.ru/=${root}`, error.message);
        await sendErrorToTelegram(`Ошибка при получении ссылки с data.products[0].root для проверки числа действий на отзыве.`, 'getCommentsURL');
        return null;
    }
}

// Функция поиска отзыва по ID
async function findFeedbackByID(rootURL, headers, feedbackID) {
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
        await sendErrorToTelegram(`Ошибка при поиске отзыва с ID ${feedbackID} при проверке числа действий на отзыве.`, 'findFeedbackByID');
    }
}

// Функция получения количества лайков или дизлайков отзыва
export async function findActionAmount(feedback, feedbackID) {
    try {
        const votes = feedback.votes;

        if (!votes) {
            throw new Error(`Не удалось найти количество действий на отзыве с ID ${feedbackID}.`);
        }

        const likes = votes.pluses;
        const dislikes = votes.minuses;

        return { id: feedbackID, likes: likes, dislikes: dislikes };
    } catch (error) {
        console.error(`Ошибка в функции findActionAmount:`, error.message);
        await sendErrorToTelegram(`Ошибка при поиске количества действий на отзыве с ID ${feedbackID}.`, 'findActionAmount');
        return null; 
    }
}

// Основная функция действия на комментарий
export async function checkLikeCommentAmount(article, feedbackID) {
    try {
        // Установка клиента с прокси
        // const client = await setupLikeAxiosInstanceWithProxy(proxyString);
        // if (!client) {
        //     throw new Error('Не удалось загрузить клиент с прокси.');
        // }

         // Получение заголовков для запроса
         const RequestHeaders = await getRequestHeaders();
         if (!RequestHeaders) {
             throw new Error('Не удалось получить заголовки запроса.');
         }

         // Получение корня
        const root = await getRoot(article, RequestHeaders);
        if (!root) {
            throw new Error('Не удалось получить корень.');
        }
        console.log('root', root);

        // Получение URL для комментариев
        const rootURL = await getCommentsURL(root, RequestHeaders);
        if (!rootURL) {
            throw new Error('Не удалось получить URL для комментариев.');
        }
        console.log('rootURL', rootURL);

         // Получение всех отзывов
         const feedback = await findFeedbackByID(rootURL, RequestHeaders, feedbackID);
         if (!feedback) {
             throw new Error('Не удалось получить все отзывы.');
         }
         console.log(feedback);

         // Находим количество лайков/дизлайков
        const actionCount = await findActionAmount(feedback, feedbackID);
        if (actionCount === undefined || actionCount === null) {
            throw new Error(`Не удалось получить количество действий на отзыве.`);
        }
        console.log(`Количество действий на отзыве:`, actionCount);
        return actionCount;

    } catch (error) {
        console.error('Ошибка в основной функции:', error.message);
        await sendErrorToTelegram(`Ошибка в основной функции проверки числа действий на отзыве: ${error.message}`, 'checkLikeCommentAmount');
        return false;
    }
}

await checkLikeCommentAmount(article, feedbackID);