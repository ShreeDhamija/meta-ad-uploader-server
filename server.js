// server.js
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const session = require('express-session');
const bizSdk = require('facebook-nodejs-business-sdk');
require('dotenv').config();

const app = express();

// Enable CORS with credentials
app.use(cors({
    origin: 'http://localhost:5173', // Your React app's URL
    credentials: true
}));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Store uploaded image hashes temporarily
let uploadedImageHashes = [];

// Auth middleware
const requireAuth = (req, res, next) => {
    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
};

// Auth endpoints
app.post('/api/auth/token', async (req, res) => {
    const { accessToken } = req.body;

    try {
        // Initialize the API with the user's token
        const api = bizSdk.FacebookAdsApi.init(accessToken);

        // Verify the token by making a test request
        const user = new bizSdk.User('me');
        const userData = await user.read(['id', 'name']);

        // Store token in session
        req.session.accessToken = accessToken;
        req.session.userData = userData;

        res.json({ success: true, userData });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(401).json({ error: 'Invalid access token' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get ad accounts
app.get('/api/ad-accounts', requireAuth, async (req, res) => {
    try {
        const api = bizSdk.FacebookAdsApi.init(req.session.accessToken);
        const user = new bizSdk.User('me');
        const adAccounts = await user.getAdAccounts([
            'account_id',
            'name',
            'currency',
            'timezone_name'
        ]);

        res.json(adAccounts);
    } catch (error) {
        console.error('Error fetching ad accounts:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle file uploads
app.post('/upload', requireAuth, upload.array('images'), async (req, res) => {
    try {
        const uploadedFiles = req.files;
        const results = [];
        uploadedImageHashes = [];

        const api = bizSdk.FacebookAdsApi.init(req.session.accessToken);

        for (const file of uploadedFiles) {
            try {
                const metaResponse = await uploadToMetaAds(file, req.body.adAccountId);
                uploadedImageHashes.push(metaResponse.hash);
                results.push({
                    filename: file.originalname,
                    status: 'success',
                    metaId: metaResponse.hash
                });
            } catch (error) {
                console.error('Error uploading to Meta:', error);
                results.push({
                    filename: file.originalname,
                    status: 'error',
                    error: error.message
                });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get campaigns for an ad account
app.get('/api/campaigns/:adAccountId', requireAuth, async (req, res) => {
    try {
        const api = bizSdk.FacebookAdsApi.init(req.session.accessToken);
        const account = new bizSdk.AdAccount(`act_${req.params.adAccountId}`);
        const campaigns = await account.getCampaigns([
            'name',
            'status',
            'objective'
        ], {
            limit: 100,
            status: ['ACTIVE']
        });

        res.json(campaigns);
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get ad sets for a campaign
app.get('/api/adsets/:campaignId', requireAuth, async (req, res) => {
    try {
        const api = bizSdk.FacebookAdsApi.init(req.session.accessToken);
        const account = new bizSdk.AdAccount(`act_${req.query.adAccountId}`);
        const adsets = await account.getAdSets([
            'name',
            'status',
            'campaign_id'
        ], {
            limit: 100,
            status: ['ACTIVE'],
            campaign_id: req.params.campaignId
        });

        res.json(adsets);
    } catch (error) {
        console.error('Error fetching ad sets:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create ad
// In server.js, modify the create-ad endpoint

app.post('/api/create-ads', requireAuth, async (req, res) => {
    try {
        const {
            name,
            primaryText,
            headline,
            description,
            link,
            callToAction,
            adsetId,
            adAccountId,
            pageId
        } = req.body;

        if (!uploadedImageHashes.length) {
            throw new Error('No images have been uploaded');
        }

        const api = bizSdk.FacebookAdsApi.init(req.session.accessToken);
        const account = new bizSdk.AdAccount(`act_${adAccountId}`);

        const results = [];

        // Create an ad for each uploaded image
        for (let i = 0; i < uploadedImageHashes.length; i++) {
            // Create creative with current image hash
            const creativeData = {
                name: `Creative for ${name} - Image ${i + 1}`,
                object_story_spec: {
                    page_id: pageId,
                    link_data: {
                        image_hash: uploadedImageHashes[i],
                        link: link,
                        message: primaryText,
                        headline: headline,
                        description: description,
                        call_to_action: {
                            type: callToAction
                        }
                    }
                }
            };

            const creative = await account.createAdCreative(
                [],
                creativeData
            );

            // Create ad with this creative
            const ad = await account.createAd(
                [],
                {
                    name: `${name} - Image ${i + 1}`,
                    adset_id: adsetId,
                    creative: { 'creative_id': creative.id },
                    status: 'ACTIVE'
                }
            );

            results.push({
                imageHash: uploadedImageHashes[i],
                adId: ad.id,
                creativeId: creative.id
            });
        }

        res.json({
            success: true,
            results: results
        });

    } catch (error) {
        console.error('Error creating ads:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Upload image to Meta Ads
async function uploadToMetaAds(file, adAccountId) {
    try {
        const account = new bizSdk.AdAccount(`act_${adAccountId}`);

        // Read file as base64
        const fileBuffer = await require('fs').promises.readFile(file.path);
        const base64Image = fileBuffer.toString('base64');

        // Upload to Meta
        const image = await account.createAdImage(
            [],
            {
                bytes: base64Image,
                name: file.originalname
            }
        );

        return {
            id: image.id,
            hash: image.hash,
            url: image.url
        };
    } catch (error) {
        console.error('Meta API Error:', error);
        throw new Error(`Meta API Error: ${error.message}`);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});