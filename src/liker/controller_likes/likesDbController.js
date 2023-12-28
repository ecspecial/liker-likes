import axios from "axios";
import { ObjectId } from 'mongodb';
import { getDb3 } from "../../../WB_module/database/config/database";
import { sendErrorToTelegram } from "../../../WB_module/telegram/telegramErrorNotifier";
import { 
    getCurrentDateInMoscow, 
    convertPeriodToMs, 
    calculateStartTimesWithMinimumInterval 
} from "../../../WB_module/queue/utility/time";

const collectionsToCheck = ['likes'];

// Минимальный интервал для расписания для коллекции likes
const MINIMUM_INTERVAL_LIKES = 300000;

// Максимум параллельных задач для коллекции likes
const MAX_TOTAL_ACTIVE_TASKS = 5;
const MAX_PARALLEL_LIKES = 5;

// Стоимость лайка для коллекции likes
const PRICE_PER_COMMENT_LIKE = 5;

const getAlreadyUsedAccountsForReviews = async (reviews, db) => {
    let usedAccounts = [];

    for (let review of reviews) {
        const query = {
            "reviews.id": review.id,
            "schedule": { $exists: true },
            "accountsUsed": { $exists: true }
        };
        const records = await db.collection('likes').find(query).toArray();

        records.forEach(record => {
            const reviewData = record.accountsUsed.find(r => r.reviewId === review.id);
            if (reviewData && reviewData.numbersUsed) {
                usedAccounts = usedAccounts.concat(reviewData.numbersUsed);
            }
        });
    }
    
    return usedAccounts;
};

// Функция поиска новых задач для коллекции likes и обновление на статус 'work'
const checkNewLikes = async () => {
    const db3 = getDb3();

    for (const collectionName of collectionsToCheck) {
        console.log(`Проверка коллекции '${collectionName}' на новые записи...`);
        let query = { status: 'created' };
        let newRecords = await db3.collection(collectionName).find(query).toArray();

        if (newRecords.length > 0) {
            console.log(`Найдены новые записи в коллекции '${collectionName}': ${newRecords.length}`);
            await updateCreatedRecords(newRecords, collectionName);
        } else {
            console.log(`В коллекции '${collectionName}' новые записи не найдены.`);
        }
    }
};

const updateCreatedRecords = async (records, collectionName) => {
    const db3 = getDb3();
    const currentTime = await getCurrentDateInMoscow();

    for (let record of records) {
        if (!record._id) {
            console.error('В записи отсутствует ID.');
            continue;
        }

        if (collectionName === 'likes' && record.dateStart) {
            const startDate = new Date(record.dateStart);
            if (currentTime < startDate) {
                console.log(`Запись с ID ${record._id} из коллекции 'likes' еще не началась. Сохраняем статус 'created'.`);
                continue;
            }
        }

        let alreadyUsedAccounts = [];
        if (collectionName === 'likes') {
            alreadyUsedAccounts = await getAlreadyUsedAccountsForReviews(record.reviews, db3);
        } else {
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "likes"');
        }

        let updateData = { $set: { endedDate: null, accountsUsed: alreadyUsedAccounts, status: 'work' } };
        let periods = [];
        let totalPeriodMs;
        let minimumInterval;

        switch (collectionName) {
            case 'likes':
                minimumInterval = MINIMUM_INTERVAL_LIKES;
                let startDate, endDate;
                if (record.dateStart) {
                    startDate = new Date(record.dateStart);
                }
                if (record.dateEnd) {
                    endDate = new Date(record.dateEnd);
                }

                if (startDate && endDate && startDate < endDate) {
                    let diffMs = endDate.getTime() - startDate.getTime();
                    periods = calculateStartTimesWithMinimumInterval(startDate, diffMs, record.total, minimumInterval);
                } else if (startDate) {
                    totalPeriodMs = 3 * 3600000;
                    periods = calculateStartTimesWithMinimumInterval(startDate, totalPeriodMs, record.total, minimumInterval);
                } else {
                    totalPeriodMs = 3 * 3600000;
                    periods = calculateStartTimesWithMinimumInterval(currentTime, totalPeriodMs, record.total, minimumInterval);
                }

                updateData = { 
                    $set: {
                        endedDate: null, 
                        accountsUsed: record.reviews.map(review => {
                            return {
                                reviewId: review.id,
                                action: 'like',
                                numbersUsed: alreadyUsedAccounts
                            };
                        }), 
                        schedule: periods, 
                        status: 'work',
                        totalLikesMade: 0, 
                        totalDislikesMade: 0, 
                        totalAmountMade: 0, 
                        type: 'likes',
                        resultReviews: record.reviews.map(review => ({ id: review.id, likesMade: 0, dislikesMade: 0 })),
                        initialReviews: record.reviews.map(review => ({ id: review.id, initialLikes: 0, initialDislikes: 0 })),
                        retryAmount: 0,
                        lastRetryDate: null
                    }
                };
                break;
        }

        await db3.collection(collectionName).updateOne({ _id: record._id }, updateData);
        console.log(`Запись с ID ${record._id} из коллекции '${collectionName}' обновлена.`);
    }
};

const processWorkRecords = async (likesCountLikes, acceptingTasks) => {
    console.log('Ищем задачи со статусом "work".');
    const db3 = getDb3();
    const currentTime = await getCurrentDateInMoscow();

    if (!acceptingTasks) {
        console.log(`Очередь API не принимает новые записи. Пропускаем итерацию.`);
        return [];
    }

    if (likesCountLikes >= MAX_PARALLEL_LIKES) {
        console.log(`Лимит очереди задач carts достигнут. Пропускаем итерацию.`);
        return [];
    }

    let workRecords = await db3.collection('carts').find({ status: 'work', schedule: { $exists: true } }).toArray();

    return workRecords.filter(record => {
        const earliestScheduledTime = new Date(record.schedule[0]);
        return currentTime >= earliestScheduledTime;
    }).slice(0, MAX_PARALLEL_LIKES - likesCountLikes);
};

// Устанавливаем новое расписание для ошибочных задач
const rescheduleIncompleteTasks = async () => {
    const db3 = getDb3();
    for (const collectionName of collectionsToCheck) {
        console.log(`Проверка коллекции '${collectionName}' на неполные задачи...`);

        let query;
        if (collectionName === 'likes') {
            // Для колекции 'likes', сравниваем 'total' и 'totalAmountMade'
            query = { 
                status: { $in: ['completed'] }, 
                endedDate: { $ne: null },
                totalAmountMade: { $exists: true, $lt: ['$totalAmountMade', '$total'] }
            };
        } else {
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "carts"');
        }

        let incompleteRecords = await db3.collection(collectionName).find(query).toArray();

        if (incompleteRecords.length > 0) {
            console.log(`Найдены неполные задачи в коллекции '${collectionName}': ${incompleteRecords.length}`);
            await rescheduleAndSetWork(incompleteRecords, collectionName, db3);
        } else {
            console.log(`Неполные задачи в коллекции '${collectionName}' не найдены.`);
        }
    }
};

// Найденные ошибочно невыполненные задачи снова отправляются на API и для них устанавливается новое расписание
const rescheduleAndSetWork = async (records, collectionName, db3) => {
    for (let record of records) {
        const remainingActions = await getRemainingActions(record, collectionName);
        let minimumInterval;

        switch (collectionName) {
            case 'likes':
                minimumInterval = MINIMUM_INTERVAL_LIKES;
                break;
            default:
                throw new Error('данный скрипт предназначен только для обработки задач коллекции "carts"');
        }

        const newSchedule = calculateStartTimesWithMinimumInterval(await getCurrentDateInMoscow(), 3 * 3600000, remainingActions, minimumInterval);

        await db3.collection(collectionName).updateOne(
            { _id: record._id },
            { 
                $set: { schedule: newSchedule, status: 'work' }
            }
        );
    }
};

// Функция для получения оставшихся действий
const getRemainingActions = (record, collectionName) => {
    if (collectionName === 'likes') {
        return record.total - record.totalAmountMade;
    }

    throw new Error('данный скрипт предназначен только для обработки задач коллекции "likes"');
};

// Найденные задачи у юзеров, которые пополнили недостающий балнс снова отправляются на API и для них устанавливается обновленное расписание
const updateNoFundsRecordsWithBalances = async () => {
    const db3 = getDb3();
    for (const collectionName of collectionsToCheck) {
        let query = { status: 'nofunds', schedule: { $exists: true }};
        const noFundsRecords = await db3.collection(collectionName).find(query).toArray();

        for (const record of noFundsRecords) {
            const user = await db3.collection('users').findOne({ _id: record.user });
            const pricePerAction = getPricePerAction(collectionName);
            let neededRemainingActions = await getRemainingActions(record, collectionName);
            let neededRemainingBalance = neededRemainingActions * pricePerAction;

            if (user && user.balance > neededRemainingBalance) {
                const remainingActions = await getRemainingActions(record, collectionName);
                let minimumInterval;

                switch (collectionName) {
                    case 'likes':
                        minimumInterval = MINIMUM_INTERVAL_LIKES;
                        break;
                    default:
                        throw new Error('данный скрипт предназначен только для обработки задач коллекции "likes"');
                }

                const newSchedule = await calculateStartTimesWithMinimumInterval(await getCurrentDateInMoscow(), 3 * 3600000, remainingActions, minimumInterval);

                await db3.collection(collectionName).updateOne(
                    { _id: record._id },
                    { 
                        $set: { schedule: newSchedule, status: 'work' }
                    }
                );
                console.log(`Запись обновлена для юзера ID: ${user._id.toString()}, коллекция: ${collectionName}`);
            }
        }
    }
};

// Получаем цену на конкретное действие
const getPricePerAction = (collectionName) => {
    switch (collectionName) {
        case 'likes':
            return PRICE_PER_COMMENT_LIKE;
        default:
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "likes"');
    }
};

// Функция для проверки проставленных лайков
const filterAndRescheduleWorkRecords = async () => {
    const db3 = getDb3();
    const currentTime = await getCurrentDateInMoscow();
    const thirtyMinutesAgo = new Date(currentTime.getTime() - (30 * 60 * 1000));

    try {
        // Проверяем записи со статусом 'work', в которых 'totalAmountMade' равнен 'total' и 'lastRetryDate' есть среди полей
        const workRecords = await db3.collection('likes').find({
            status: 'work',
            totalAmountMade: { $eq: "$total" },
            lastRetryDate: { $exists: true }
        }).toArray();

        const eligibleRecords = [];
        for (const record of workRecords) {
            if (eligibleRecords.length >= 3) {
                break;
            }

            const lastRetryTime = record.lastRetryDate ? new Date(record.lastRetryDate) : null;
            
            if (!lastRetryTime || lastRetryTime < thirtyMinutesAgo) {
                await db3.collection('likes').updateOne(
                    { _id: new ObjectId(record._id) },
                    { $set: { lastRetryDate: currentTime } }
                );

                eligibleRecords.push(record);
            }
        }

        return eligibleRecords;
    } catch (error) {
        console.error('Error in filterAndRescheduleWorkRecords:', error);
        await sendErrorToTelegram(`Ошибка в функции filterAndRescheduleWorkRecords: ${error.message}`);
        return [];
    }
};

export { checkNewLikes, processWorkRecords, rescheduleIncompleteTasks, updateNoFundsRecordsWithBalances, filterAndRescheduleWorkRecords }