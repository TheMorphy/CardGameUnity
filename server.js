require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { message } = require("telegraf/filters");
const path = require('path');
const process = require('process');
const ngrok = require("@ngrok/ngrok");
const bodyParser = require('body-parser');
const axios = require('axios'); // Для отправки запросов к Telegram API
const cors = require('cors');

const HOOK_PATH = process.env.HOOK_PATH || "hook";
const TELEGRAM_API_URL = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`; // API URL Telegram

let currentNgrokUrl = ''; // Переменная для хранения URL ngrok

const rules = `
Each player is dealt 26 cards.

Players alternately discard one card from their hand.

When some of the following combinations occur players race to slap the discard pile:
 * Double (e.g. 2-2)
 * Marriage (e.g. K-Q)
 * Sandwich (e.g. 2-5-2)
 * Divorce (e.g. Q-10-K)
 * Three in a Row (e.g. K-1-2, 3-4-5)

The player who slaps first takes all the cards from the pile.

If someone slaps when there is no valid combination, the other player takes all the cards.

The goal of the game is to have all 52 cards in your hand.
`;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, '/'), {
    setHeaders: function (res, path) {
        if (path.match('.br')) {
            res.set('Content-Encoding', 'br');
            res.set('Content-Type', 'application/wasm');
        }
    }
}));

app.use((req, res, next) => {
    const secret = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (process.env.SECRET_TOKEN !== secret) {
        return res.sendStatus(301);
    }
    next();
});

// Обработка preflight запросов для CORS
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200); // Успешный ответ для preflight запросов
});

// Настройка CORS
const corsOptions = {
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'], 
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: { webhookReply: true },
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Маршрут для создания инвойса
app.post('/createInvoice', async (req, res) => {
    console.log(`Метод запроса: ${req.method}`); // Лог метода запроса
    console.log(`Тело запроса: ${JSON.stringify(req.body)}`); // Лог тела запроса

    const { chat_id, title, description, payload, amount } = req.body;

    const invoice = {
        chat_id: chat_id,
        title: title,
        description: description,
        payload: payload,
        provider_token: "", // Пустая строка для Telegram Stars
        currency: "XTR",
        prices: [
            { label: title, amount: amount } // amount в минимальных единицах (звезды)
        ]
    };

    try {
        const response = await axios.post(`${TELEGRAM_API_URL}/sendInvoice`, invoice);
        console.log('Ответ от Telegram API:', response.data); // Лог ответа от API Telegram
        res.json(response.data); // Возвращаем ответ
    } catch (error) {
        console.error('Ошибка при создании инвойса:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: error.response ? error.response.data : 'Unknown error' });
    }
});

// Маршрут для получения текущего URL ngrok
app.get('/currentNgrokUrl', (req, res) => {
    res.json({ url: currentNgrokUrl });
});

// Обработка webhook для платежей
app.post('/paymentWebhook', async (req, res) => {
    const update = req.body;

    if (update.pre_checkout_query) {
        const preCheckoutQuery = update.pre_checkout_query;

        // Здесь мы подтверждаем, что можем обработать платеж
        try {
            await axios.post(`${TELEGRAM_API_URL}/answerPreCheckoutQuery`, {
                pre_checkout_query_id: preCheckoutQuery.id,
                ok: true
            });
        } catch (error) {
            console.error('Error answering pre_checkout_query:', error.response ? error.response.data : error.message);
            await axios.post(`${TELEGRAM_API_URL}/answerPreCheckoutQuery`, {
                pre_checkout_query_id: preCheckoutQuery.id,
                ok: false,
                error_message: 'Unable to process your payment at this time.'
            });
        }
    }

    if (update.message && update.message.successful_payment) {
        const payment = update.message.successful_payment;
        console.log('Payment received:', payment);
        // Обновление данных пользователя или другие действия
    }

    res.sendStatus(200);
});

if (process.env.NODE_ENV === 'development') {
    const setupNgrok = async () => {
        await ngrok.authtoken(process.env.NGROK_AUTHTOKEN);
        const url = await ngrok.connect({ addr: process.env.PORT });
        currentNgrokUrl = url; // Сохраняем текущий URL ngrok
        console.log('ngrok URL:', url);
        bot.telegram.setWebhook(`${url}/${HOOK_PATH}`, {
            secret_token: process.env.SECRET_TOKEN,
            allowed_updates: ['message', 'pre_checkout_query', 'successful_payment']
        });

        app.post(`/${HOOK_PATH}`, async (req, res) => {
            bot.handleUpdate(req.body, res);
        });

        bot.on(message('text'), async (ctx) => {
            await ctx.reply(rules, Markup.inlineKeyboard([{
                text: "🤟Let's play🤟!!!",
                web_app: {
                    url: url
                }
            }]));
        });
    };
    setupNgrok();
} else {
    bot.telegram.setWebhook(`${process.env.APP_ENDPOINT}/${HOOK_PATH}`, {
        secret_token: process.env.SECRET_TOKEN,
        allowed_updates: ['message', 'pre_checkout_query', 'successful_payment']
    });

    app.post(`/${HOOK_PATH}`, async (req, res) => {
        bot.handleUpdate(req.body, res);
    });

    bot.on(message('text'), async (ctx) => {
        await ctx.reply(rules, Markup.inlineKeyboard([{
            text: "🤟Let's play🤟!!!",
            web_app: {
                url: process.env.APP_ENDPOINT
            }
        }]));
    });
}

app.listen(process.env.PORT, () => {
    console.log(`Server running at http://localhost:${process.env.PORT}/`);
});
