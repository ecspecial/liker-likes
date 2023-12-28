import axios from 'axios';
import { ObjectId } from 'mongodb';
import { getDb } from '../../../../WB_module/database/config/database.js';
import { sendErrorToTelegram } from '../../../../WB_module/telegram/telegramErrorNotifier.js';
import { likeComment } from '../liker/likerComment.js';

// Функция-обёртка для повторного выполнения функций
async function executeWithRetry(action, ...params) {
    const maxRetries = 1;
    // const delay = 60000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await action(...params);
        } catch (error) {
            if (attempt < maxRetries) {
                console.warn(`Ошибка в ${action.name}. Попытка ${attempt} из ${maxRetries}. Повтор через ${delay/1000} секунд...`, error);
                // await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`Достигнуто максимальное количество попыток для ${action.name}. Завершаем...`, error);
                sendErrorToTelegram(`Ошибка после ${maxRetries} попыток в ${action.name} для номера ${params[0]}.`, action.name);
                return 'ERROR_MAX_RETRIES';
            }
        }
    }
    return 'ERROR';
}

export async function likeCommentHandler(phoneNumber, proxy, article, actionType, account, feedbackID) {
    try {
        const success = await executeWithRetry(likeComment, proxy, article, phoneNumber, actionType, account, feedbackID);

        if (!success || success === 'ERROR_MAX_RETRIES') {
            console.warn('Не удалось выполнить действие после всех попыток в likeCommentHandler.');
            sendErrorToTelegram(`Не удалось выполнить действие после всех попыток для номера ${phoneNumber}.`, 'likeCommentHandlerWarning');
        }
        return success;
    } catch (error) {
        console.error('Ошибка в likeCommentHandler:', error);
        sendErrorToTelegram(error.message, 'likeCommentHandler');
        return 'ERROR';
    }
}