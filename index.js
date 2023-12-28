import axios from 'axios';
import cors from 'cors';
import chalk from 'chalk';
import async from 'async';
import dotenv from 'dotenv';
import express from 'express';
import { ObjectId } from 'mongodb';
import { getIPAddress } from './WB_module/network/utility/ip.js';
import { getCurrentDateInMoscow } from './WB_module/queue/utility/time.js';
import { checkProxy } from './WB_module/network/controller/networkController.js';
import { sendErrorToTelegram } from './WB_module/telegram/telegramErrorNotifier.js';
import { checkLikeCommentAmount } from './src/liker/liker_likes/liker/likerChecker.js';
import { likeCommentHandler } from './src/liker/liker_likes/controller/likerController.js';
import { 
    getProxyWithRetries, 
    getRandomPhoneNumberWithRetries, 
    getRandomMobileAccountWithRetries 
} from './WB_module/queue/utility/resourses.js';
import { 
    databaseConnectRequest,
    getDb,
    database2ConnectRequest,
    getDb2,
    database3ConnectRequest,
    getDb3, 
} from './WB_module/database/config/database.js';
import { 
    checkNewLikes, 
    processWorkRecords, 
    rescheduleIncompleteTasks, 
    updateNoFundsRecordsWithBalances, 
    filterAndRescheduleWorkRecords 
} from './src/liker/controller_likes/likesDbController.js';

// Подключение env файла
dotenv.config();

// Настройка сервера express + использование cors и json
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4003;

// Стоимость лайка на продукт/бренд
const PRICE_PER_COMMENT_LIKE = 5;

// Настройка минимального интервала для лайков
const MINIMUM_INTERVAL_LIKES = 300000;

// Настройка максимально допустиых значений параллельного запуска функций
const MAX_TOTAL_ACTIVE_TASKS = 5;
const MAX_PARALLEL_LIKES = 5;

// Настройка максимально допустимых значений повторного добавления в очередь
const RETRY_LIMIT = 3;
const READD_RETRY_LIMIT = 10;

// Настройка максимально допустимых значений повторного получения прокси
const PROXY_RETRY_LIMIT = 10;

// Настройка параметра возможности добавления новых задач в очередь
let acceptingTasks = true;

// Текущие активные задачи
let totalActiveTasks = 0;
let likesCount = {
    likes: 0
};

// Интервалы проверки базы данных
const INTERVAL_NEW_LIKES = 20000;
const INTERVAL_WORK_LIKES = 25000;
const INTERVAL_INCOMPLITE_LIKES = 30000;
const INTERVAL_NOFUNDS_LIKES = 35000;
const INTERVAL_CHECK_FINISHED = 600000;

// Метод получения базового ответа от API likes
app.get('/api/', (req, res) => {
    res.status(200).json('Привет от API likes!');
});

// Метод остановки принятия задач в очередь API likes
app.post('/api/stopQueue', async (req, res) => {
    acceptingTasks = false;
    res.status(200).json({ message: 'Остановили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API likes
app.post('/api/startQueue', async (req, res) => {
    acceptingTasks = true;
    res.status(200).json({ message: 'Возобновили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API cartsliker
app.post('/api/resetQueueCount', async (req, res) => {
    totalActiveTasks = 0;
    likesCount['likes'] = 0;
    res.status(200).json({ message: 'Сбросили очередь.' });
});

// Метод получения статуса очереди API likes
app.get('/api/queueStatus', async (req, res) => {
    try {
        const queueInfo = await getQueueInfo(likeQueue, acceptingTasks, totalActiveTasks, likesCount);
        res.status(200).json({
            message: 'Текущее состояние очереди',
            queueInfo: queueInfo
        });
    } catch (error) {
        console.error('Ошибка получения статуса очереди:', error);
        res.status(500).json({ error: 'Ошибка получения статуса очереди' });
    }
});

const startServer = async () => {
    try {
        console.log('Попытка подключения к базе данных...');
        const isConnected = await databaseConnectRequest();
        if (!isConnected) {
            throw new Error('Подключение к базе данных  не может быть установлено');
        }

        const isConnected2 = await database2ConnectRequest();
        if (!isConnected2) {
            throw new Error('Подключение к базе данных  не может быть установлено');
        }

        const isConnected3 = await database3ConnectRequest();
        if (!isConnected3) {
            throw new Error('Подключение к базе данных  не может быть установлено');
        }

        console.log(chalk.grey('Запускаем сервер...'));
        app.listen(PORT, async () => {
            console.log(chalk.green(`Сервер запущен на порту ${PORT}`));

            setInterval(async () => {
                try {
                    await processLikeQueue();
                } catch (error) {
                    console.error('Ошибка при проверке новых лайков:', error);
                    await sendErrorToTelegram(`Ошибка при проверке очереди лайков: ${error.message}`, 'processLikeQueue');
                }
            }, INTERVAL_NEW_LIKES);

            setInterval(async () => {
                try {
                    await checkNewLikes();
                } catch (error) {
                    console.error('Ошибка при проверке новых лайков:', error);
                    await sendErrorToTelegram(`Ошибка при проверке новых лайков: ${error.message}`, 'checkNewLikes');
                }
            }, INTERVAL_NEW_LIKES);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        let eligibleRecords = await processWorkRecords(totalActiveTasks, acceptingTasks);
                        console.log('Записи готовые к обработке в статусе "work":', eligibleRecords);
                        await addEligibleRecordsToQueue(eligibleRecords);
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей в статусе "work":', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей в статусе "work": ${error.message}`, 'processWorkRecords');
                }
            }, INTERVAL_WORK_LIKES);

            setInterval(async () => {
                try {
                    const finishedRecords = await filterAndRescheduleWorkRecords();
                    if (finishedRecords.length > 0) {
                        await checkFinishedRecords(finishedRecords);
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей на которых все лайки проставлены запросами:', error);
                    await sendErrorToTelegram(`Ошибка при проверке завершенных записей на которых все лайки проставлены запросами: ${error.message}`, 'checkFinishedRecords');
                }
            }, INTERVAL_CHECK_FINISHED);

            setInterval(async () => {
                try {
                    await rescheduleIncompleteTasks();
                } catch (error) {
                    console.error('Ошибка при проверке неполных записей:', error);
                    await sendErrorToTelegram(`Ошибка при проверке неполных записей: ${error.message}`, 'rescheduleIncompleteTasks');
                }
            }, INTERVAL_INCOMPLITE_LIKES);

            setInterval(async () => {
                try {
                    await updateNoFundsRecordsWithBalances();
                } catch (error) {
                    console.error('Ошибка при проверке записей без баланса:', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей без баланса: ${error.message}`, 'updateNoFundsRecordsWithBalances');
                }
            }, INTERVAL_NOFUNDS_LIKES);
        });


    } catch (error) {
        console.error(chalk.red('Ошибка при запуске сервера:', error));
        await sendErrorToTelegram(`Ошибка при запуске сервера: ${error.message}`, 'startServer');
    }
};

startServer().then(server => {
    if (server) {
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(chalk.red(`Порт ${PORT} занят!`));
            } else {
                console.error(chalk.red('Произошла ошибка при запуске сервера:'), error);
            }
        });
    }
});

// Логика воркера очереди задач
const likeQueue = async.queue(async (task) => {
    try {
        switch (task.likeRecord.type) {
            case 'likes':
                console.log('Обработка очереди likes');
                await processCommentLike(task);
                break;
            default:
                throw new Error(`Данный сервер предназначен для обработки задач из коллекции likes, получили: ${task.likeRecord.type}`);
        }
    } catch (error) {
        console.error(`Ошибка при обработке likeId ${task.likeRecord._id.toString()}:`, error);
        await sendErrorToTelegram(`Ошибка при обработке likeId ${task.likeRecord._id.toString()}: ${error.message}`, 'processLikeQueue');

        if (error.message === 'NO_AVAILABLE_PROXY' || error.message === 'NO_AVAILABLE_ACCOUNT') {
            await reAddToLikeQueueWithTimeout(task.likeRecord, task.retries);
        } else {
            throw error;
        }
    }
}, MAX_TOTAL_ACTIVE_TASKS);

likeQueue.error((err, task) => {
    console.error('Ошибка при обработке задачи:', err, 'Задача:', task);
});

// Функция добавления задач в очередь
const addEligibleRecordsToQueue = async (eligibleRecords) => {
    for (const record of eligibleRecords) {
        if (totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            const db = getDb();
            await db.collection('likes').updateOne({ _id: record._id }, { $pull: { schedule: new Date(record.schedule[0]) } });
            likeQueue.push({ likeRecord: record, retries: 0 });
            totalActiveTasks++;
            likesCount['likes']++;
        }
    }
};

// Функция задержки
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция получения информации об очереди
const getQueueInfo = async () => {
    return {
        length: likeQueue.length(),
        isProcessing: !likeQueue.idle(),
        acceptingTasks: acceptingTasks,
        totalActiveTasks: totalActiveTasks,
        typesCount: likesCount,
    };
};

// Функция отслеживания очереди задач
const processLikeQueue = async () => {
    console.log("Начало обработки очереди лайков");
    console.log("Очередь: ", likeQueue.length());

    if (likeQueue.idle()) {
        console.log("Очередь лайков пуста");
    } else {
        console.log("Очередь обрабатывает задачи");
    }
}

// Функция добавления likeRecord в очередь с начальным количеством попыток
async function reAddToLikeQueueWithTimeout(likeRecord, retries) {
    if (retries < PROXY_RETRY_LIMIT) {
        const db3 = getDb3();
        const idString = likeRecord._id.toString();
        await delay(180000);
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
        console.log(`likeId ${likeRecord._id} добавлен обратно в очередь после задержки.`);
    } else {
        await totalActiveTasks--;
        await likesCount['likes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('likes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_LIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('likes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueWithTimeout');
        }
    }
}

// Функция для повторного добавления likeRecord в очередь с обновленным количеством попыток
async function reAddToLikeQueue(likeRecord, retries) {
    const db3 = getDb3();
    const idString = likeRecord._id.toString();
    if (retries < RETRY_LIMIT) {
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await likesCount['likes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('likes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_LIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('likes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueue');
        }
    }
}

// Функция для повторного добавления likeRecord в очередь без обновления количества попыток
async function reAddToLikeQueueNoAdd(likeRecord, retries) {
    const db3 = getDb3();
    const idString = likeRecord._id.toString();
    if (retries < READD_RETRY_LIMIT) {
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await likesCount['likes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('likes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_LIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('likes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция уменьшения очереди определенного типа лайков
const decrementLikeCount = async (type) => {
    // Проверяем, что тип лайка существует в массиве и больше нуля
    if (likesCount[type] !== undefined && likesCount[type] > 0) {
        likesCount[type]--;
        return likesCount;
    } else {
        console.warn(`Попытка умеьшить likesCount[${type}] невозможна, значение уже 0.`);
        return false;
    }
}



// Функция обработки лайков комментариев
async function processCommentLike(task) {
    const likeRecord = task.likeRecord;
    const db = await getDb();
    const db2 = await getDb2();
    const db3 = await getDb3();
    const idString = likeRecord._id.toString();

    try {
        console.log('Начинается обработка записи', idString);

        let like = await db3.collection('likes').findOne({ _id: new ObjectId(idString) });
        if (!like) {
            console.error(`Не найдена запись для likeId ${idString} в базе данных.`);

            await totalActiveTasks--;
            await likesCount['likes']--;

            return;
        }
        console.log('Запись успешно получена из базы:', idString);

        const user = await db3.collection('users').findOne({ _id: like.user });
        if (!user) {
            console.error(`Не найден user для likeId ${idString} в базе данных.`);

            await totalActiveTasks--;
            await likesCount['likes']--;

            return;
        }

        const costForAllActions = (like.total - like.totalAmountMade) * PRICE_PER_COMMENT_LIKE;
        console.log('costForAllActions', costForAllActions);
        const hasSufficientBalance = user.balance >= costForAllActions;
        console.log('user.balance', user.balance);
        console.log('hasSufficientBalance', hasSufficientBalance);

        if (!hasSufficientBalance) {
            console.error(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий с отзывом.`);
            await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий с отзывом.`, 'processCommentLike');

            await db3.collection('likes').updateOne(
                { _id: new ObjectId(idString) },
                { $set: { status: 'nofunds' } }
            );

            await totalActiveTasks--;
            await likesCount['likes']--;

            return;
        }

        let remainingActions = like.total - like.totalAmountMade;
        console.log('Оставшиеся действия:', remainingActions);

        if (remainingActions <= 0) {
            if (like.endedDate === null || like.status === 'work') {
                const updateResult = await db3.collection('likes').updateOne(
                    { _id: new ObjectId(idString) },
                    {
                        $set: { 
                            status: 'completed',
                            endedDate: await getCurrentDateInMoscow()
                        }
                    }
                );
    
                if (updateResult.modifiedCount !== 1) {
                    console.warn(`Не удалось установить статус 'completed' для likeId ${idString}`);
                } else {
                    console.log(`Задача на лайк/дизлайк коммента с likeId ${idString} завершена.`);
                }
            }

            await totalActiveTasks--;
            await likesCount['likes']--;

            console.warn(`Задача с likeId ${idString} уже получила все необходимые лайки/дизлайки.`);
            // await sendErrorToTelegram(`Задача с likeId ${idString} уже получила все необходимые лайки/дизлайки.`, 'processCartLike');
            return;
        }

        if (likesCount['likes'] < MAX_TOTAL_ACTIVE_TASKS && totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            const user = await db3.collection('users').findOne({ _id: like.user });
            const balanceRequiredForOneAction = PRICE_PER_COMMENT_LIKE;

            if (user.balance < balanceRequiredForOneAction) {
                console.error(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего лайка на отзыв.`);
                
                await db3.collection('likes').updateOne(
                    { _id: new ObjectId(idString) },
                    { $set: { status: 'nofunds' } }
                );

                await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего лайка на отзыв.`, 'processCommentLike');

                await totalActiveTasks--;
                await likesCount['likes']--;
                
                return;
            }

            if (like.totalAmountMade == 0) {
                try {
                    let initialActionsMap = {};
            
                    for (let review of like.reviews) {
                        const initialActions = await checkLikeCommentAmount(like.article, review.id);
                        if (initialActions === undefined || initialActions === null) {
                            await sendErrorToTelegram(`Не удалось получить количество действий на отзыве ${review.id} для действия на комментарий по артикулу ${like.article}`, 'checkLikeCommentAmount в processCommentLike');
                            throw new Error(`Не удалось получить количество действий на отзыве ${review.id} для действия на комментарий по артикулу ${like.article}`);
                        }
                        initialActionsMap[review.id] = initialActions;
                    }
            
                    const initialReviewsUpdate = like.reviews.map(review => {
                        let initialActions = initialActionsMap[review.id];
                        return {
                            id: review.id,
                            initialLikes: initialActions.likes,
                            initialDislikes: initialActions.dislikes
                        };
                    });
            
                    await db3.collection('likes').updateOne(
                        { _id: new ObjectId(idString) },
                        { $set: { initialReviews: initialReviewsUpdate } }
                    );
            
                } catch (error) {
                    await sendErrorToTelegram(`Не удалось получить количество действий на отзыве ${like.article}.`);
                    throw new Error(`Не удалось получить количество действий на отзыве ${like.article}.`);
                }
            }

            let actionTaken = false;
            for (let review of like.reviews) {
                if (actionTaken) break;
                console.log('Обработка отзыва:', review);
        
                // Определяем действие исходя из текущего отзыва
                const resultReview = like.resultReviews.find(r => r.id === review.id);
                let action;
                
                if (review.likes > resultReview.likesMade) {
                    action = 'like';
                } else if (review.dislikes > resultReview.dislikesMade) {
                    action = 'dislike';
                } else {
                    console.log(`Все необходимые лайки/дислайки были выполнены для reviewId ${review.id} с likeId ${idString}.`);
                    continue;
                }
        
                const proxy = await getProxyWithRetries();
                console.log('Получен прокси:', proxy);
        
                const accountInfo = await getRandomMobileAccountWithRetries(idString, review.id, 'likes');
                if (!accountInfo) {
                    console.error(`Информация об аккаунте не найдена для отзыва с ID ${review.id}`);
                    continue; // Переход к следующей итерации
                }
                console.log('Информация об аккаунте успешно получена:', accountInfo);
                const account = accountInfo.account;
                const phoneNumber = accountInfo.number;
        
                const outcome = await likeCommentHandler(phoneNumber, proxy, like.article, action, account, review.id);
                console.log('-------> OUTCOME:', outcome);
                
                if (outcome) {
                    console.log('Отправлено на обработку лайк/дизлайк:', like);
                    console.log('Результат обработчика лайка/дизлайка:', outcome);
        
                    let updateFields = {
                        $inc: {
                            totalAmountMade: 1,
                            ...(action === 'like' ? { totalLikesMade: 1 } : { totalDislikesMade: 1 })
                        },
                        $push: { "accountsUsed.$[elem].numbersUsed": phoneNumber }
                    };
        
                    let resultReviewUpdate = {
                        $inc: {
                            ...(action === 'like' ? { "resultReviews.$.likesMade": 1 } : { "resultReviews.$.dislikesMade": 1 })
                        }
                    };
        
                    await db3.collection('likes').updateOne(
                        { _id: new ObjectId(idString), "resultReviews.id": review.id },
                        updateFields,
                        { arrayFilters: [{ "elem.reviewId": review.id }] }
                    );
        
                    await db3.collection('likes').updateOne(
                        { _id: new ObjectId(idString), "resultReviews.id": review.id },
                        resultReviewUpdate
                    );
        
                    const paymentTask = {
                        user: like.user,
                        status: 'created',
                        type: like.type,
                        taskId: like._id,
                        createdDate: await getCurrentDateInMoscow(),
                        sum: PRICE_PER_COMMENT_LIKE
                    };
                    
                    try {
                        const insertResult = await db2.collection('Task').insertOne(paymentTask);
                        if (insertResult.acknowledged !== true || insertResult.insertedId == null) {
                            await sendErrorToTelegram('Не удалось вставить новый Task на списание баланса.');
                            throw new Error('Не удалось вставить новый Task на списание баланса.');
                        }
                        const paymentHistoryRecord = {
                            user: like.user,
                            summ: PRICE_PER_COMMENT_LIKE,
                            typeoperations: 'Расход',
                            basisoperation: `Лайки ${like._id.toString()}`,
                            dataoperation: await getCurrentDateInMoscow(),
                            comment: '',
                            type: like.type
                        };
                    
                        const insertPaymentHistoryResult = await db3.collection('paymenthistories').insertOne(paymentHistoryRecord);
                        if (insertPaymentHistoryResult.acknowledged !== true || insertPaymentHistoryResult.insertedId == null) {
                            await sendErrorToTelegram('Не удалось записать историю операций в коллекцию paymenthistories.');
                            throw new Error('Не удалось записать историю операций в коллекцию paymenthistories.');
                        }

                        await totalActiveTasks--;
                        await likesCount['likes']--;

                        console.log(`Действие на коммент для likeId ${idString} успешно обработано`);
                    
                    } catch (error) {
                        console.error(`Ошибка при добавлении записей в коллекции Task и/или paymenthistories: ${error.message}`);
                        await sendErrorToTelegram(`Ошибка при добавлении записей для пользователя с ID ${like.user.toString()} в коллекции Task и/или paymenthistories: ${error.message}`, 'processCommentLike');
                        throw error;
                    }

                    // remainingActions--;
                    actionTaken = true;
                    break;
        
                } else {
                    console.warn(`Действие "${action}" не удалось на отзыв для номера: ${phoneNumber}`);
                    reAddToLikeQueue(task.likeRecord, task.retries);
                }
        
                if (phoneNumber) {
                    console.log('Освобождение номера телефона:', phoneNumber);
                    await db.collection('mobileaccounts').updateOne({ number: phoneNumber }, { $set: { status: 'free' } });
                }
        
                if (proxy) {
                    console.log('Проверка работоспособности прокси:', proxy);
                    const isProxyWorking = await checkProxy(proxy);
                    console.log('Прокси работает:', isProxyWorking);
                    const updateData = isProxyWorking ? { status: 'free', lastUsedIP: isProxyWorking } : { status: 'free' };
                    await db.collection('proxies').updateOne({ proxy: proxy }, { $set: updateData });
                }
            }
            
            like = await db3.collection('likes').findOne({ _id: new ObjectId(idString) });
            remainingActions = like.total - like.totalAmountMade;
            // console.log('Оставшиеся действия:', remainingActions);
        }

        // if (remainingActions == 0) {
        //     const updateResult = await db3.collection('likes').updateOne(
        //         { _id: new ObjectId(idString) },
        //         {
        //             $set: { 
        //                 status: 'completed',
        //                 endedDate: await getCurrentDateInMoscow(),
        //             }
        //         }
        //     );

        //     if (updateResult.modifiedCount !== 1) {
        //         console.warn(`Не удалось установить статус "completed" для likeId ${idString}`);
        //         await sendErrorToTelegram(`Не удалось установить статус "completed" для likeId ${idString}`, 'processLikeQueue');
        //     } else {
        //         console.log(`Задача лайка с likeId ${idString} завершена.`);
        //     }
        // }

    } catch (error) {
        console.error('Ошибка в функции processCommentLike:', error);
        const errorMessage = `Ошибка при обработке likeId ${idString}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'processLikeQueue');

        throw error;
    }
}

// Проверка выставленных лайков с лайками на ВБ, выставление при необходимости нового расписания
const checkFinishedRecords = async (records) => {
    const db3 = getDb3();

    for (const record of records) {
        const idString = record._id.toString();
        let additionalDates = [];
        let isCompleted = true;

        for (const review of record.reviews) {
            const currentActions = await checkLikeCommentAmount(record.article, review.id);
            const initialReview = record.initialReviews.find(r => r.id === review.id);
            const resultReview = record.resultReviews.find(r => r.id === review.id);

            const actualLikesMade = currentActions.likes - initialReview.initialLikes;
            const actualDislikesMade = currentActions.dislikes - initialReview.initialDislikes;

            if (actualLikesMade !== resultReview.likesMade || actualDislikesMade !== resultReview.dislikesMade) {
                isCompleted = false;
                if (record.retryAmount >= 5) {
                    const likeDiff = review.likes - actualLikesMade;
                    const dislikeDiff = review.dislikes - actualDislikesMade;

                    for (let i = 0; i < likeDiff + dislikeDiff; i++) {
                        const nextDate = new Date(
                            additionalDates.length > 0 
                                ? additionalDates[additionalDates.length - 1].getTime() + MINIMUM_INTERVAL_LIKES 
                                : await getCurrentDateInMoscow().getTime()
                        );
                        additionalDates.push(nextDate);
                    }

                    const updatedLikes = currentActions.likes - initialReview.initialLikes;
                    const updatedDislikes = currentActions.dislikes - initialReview.initialDislikes;

                    await db3.collection('likes').updateOne(
                        { _id: record._id, "resultReviews.id": review.id },
                        { 
                            $set: { 
                                "resultReviews.$.likesMade": updatedLikes, 
                                "resultReviews.$.dislikesMade": updatedDislikes 
                            } 
                        }
                    );

                    await db3.collection('likes').updateOne(
                        { _id: record._id },
                        { 
                            $set: { 
                                totalLikesMade: actualLikesMade,
                                totalDislikesMade: actualDislikesMade,
                                totalAmountMade: actualLikesMade + actualDislikesMade
                            }
                        }
                    );
                }
            }
        }

        if (isCompleted) {
            await db3.collection('likes').updateOne(
                { _id: new ObjectId(idString) },
                {
                    $set: { 
                        status: 'completed',
                        endedDate: await getCurrentDateInMoscow(),
                    }
                }
            );
        } else if (record.retryAmount < 5 || additionalDates.length === 0) {
            await db3.collection('likes').updateOne(
                { _id: record._id },
                { $inc: { retryAmount: 1 } }
            );
        } else if (additionalDates.length > 0) {
            await db3.collection('likes').updateOne(
                { _id: record._id },
                { 
                    $push: { schedule: { $each: additionalDates } },
                    $set: { retryAmount: 0 }
                }
            );
        }
    }
};