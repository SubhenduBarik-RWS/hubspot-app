const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');
const session = require('express-session');
const crypto = require('crypto');
const axios = require('axios');
var cors = require('cors');

const app = express();

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 8080;
const CLIENT_ID = '59a080c9-fbbb-4fe4-8b29-344c8768cf08';
const CLIENT_SECRET = '41492b90-2263-40aa-af44-a4337de28782';

const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

let SCOPES = ['sales-email-read crm.objects.contacts.read crm.objects.marketing_events.read content'];

const REDIRECT_URI = `http://${HOST}:${PORT}/oauth-callback`;

const authUrl =
    'https://app.hubspot.com/oauth/authorize' +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
    `&scope=${encodeURIComponent(SCOPES)}` + // scopes being requested by the app
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

const corsOptions = {
    origin: '*',
    credentials: true, //access-control-allow-credentials:true
    optionSuccessStatus: 200,
};

app.use(cors(corsOptions));

app.use(
    session({
        genid: function (req) {
            return crypto.randomUUID(); // use UUIDs for session IDs
        },
        secret: 'secret',
        maxAge: Date.now() + 30 * 86400 * 1000,
        resave: false,
        saveUninitialized: true,
        // cookie: { secure: true },
    })
);

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/install', (req, res) => {
    console.log('');
    console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
    console.log('');
    console.log("===> Step 1: Redirecting user to your app's OAuth URL");
    res.redirect(authUrl);
    console.log('===> Step 2: User is being prompted for consent by HubSpot');
});

app.get('/oauth-callback', async (req, res) => {
    console.log('===> Step 3: Handling the request sent by the server');

    // Received a user authorization code, so now combine that with the other
    // required values and exchange both for an access token and a refresh token
    if (req.query.code) {
        console.log('       > Received an authorization token');

        const authCodeProof = {
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            code: req.query.code,
        };

        // Step 4
        // Exchange the authorization code for an access token and refresh token
        console.log('===> Step 4: Exchanging authorization code for an access token and refresh token');
        const token = await exchangeForTokens(req.sessionID, authCodeProof);
        if (token.message) {
            return res.redirect(`/error?msg=${token.message}`);
        }

        // Once the tokens have been retrieved, use them to make a query
        // to the HubSpot API
        res.cookie('sessionID', req.sessionID);
        // let redirUrl = 'http://127.0.0.1:5173/';
        // req.session.save((err) => {
        //     return res.redirect(302, redirUrl);
        // });
        res.redirect('/');
    }
});

const exchangeForTokens = async (userId, exchangeProof) => {
    try {
        const responseBody = await axios.post('https://api.hubapi.com/oauth/v1/token', new URLSearchParams(exchangeProof));
        // Usually, this token data should be persisted in a database and associated with
        // a user identity.
        refreshTokenStore[userId] = responseBody.data.refresh_token;
        accessTokenCache.set(userId, responseBody.data.access_token, Math.round(responseBody.data.expires_in * 0.75));

        console.log('       > Received an access token and refresh token');
        return responseBody.data.access_token;
    } catch (e) {
        console.error(`       > Error exchanging ${exchangeProof.grant_type} for access token`);
        console.log(e.response);
    }
};

const refreshAccessToken = async (userId) => {
    const refreshTokenProof = {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        refresh_token: refreshTokenStore[userId],
    };
    return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
    if (!accessTokenCache.get(userId)) {
        console.log('Refreshing expired access token');
        await refreshAccessToken(userId);
    }
    return accessTokenCache.get(userId);
};

const getContacts = async (sessionId) => {
    console.log('=== Retrieving a contact from HubSpot using the access token ===');
    try {
        const accessToken = await getAccessToken(sessionId);
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        };

        const result = await axios.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all', {
            headers: headers,
        });

        return result.data.contacts;
    } catch (e) {
        console.error('  > Unable to retrieve contact');
        return JSON.parse(e.response.body);
    }
};

const getEmails = async (sessionId) => {
    try {
        const accessToken = await getAccessToken(sessionId);
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        };

        const result = await axios.get('https://api.hubapi.com/marketing-emails/v1/emails', {
            headers: headers,
        });

        return result.data;
    } catch (e) {
        console.error('  > Unable to retrieve emails');
        return JSON.parse(e.response.body);
    }
};

app.get('/api/isAuthorized', function (req, res) {
    // res.send(true);
    const isAuthorized = refreshTokenStore[req.sessionID] ? true : false;
    res.send(isAuthorized);
});

app.get('/api/contacts', async (req, res) => {
    const contacts = (await getContacts(req.sessionID)).map((x) => ({
        vid: x.vid,
        firstName: x.properties.firstname?.value,
        lastName: x.properties.lastname?.value,
        company: x.properties.company?.value,
        name: x.properties.firstname?.value + ' ' + x.properties.lastname?.value,
    }));
    res.send(contacts);
});

app.get('/api/emails', async (req, res) => {
    const emails = await getEmails(req.sessionID);
    res.send(emails);
});

app.listen(PORT, () => console.log(`listening on ${PORT}`));
