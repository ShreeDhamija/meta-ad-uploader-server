const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const session = require('express-session');
const dotenvResult = require('dotenv').config();



const app = express();

// Parse JSON bodies
app.use(express.json());
app.set('trust proxy', 1);

app.use(cors({
  origin: 'https://batchadupload.vercel.app', // Replace with your React app's origin
  credentials: true               // This enables sending cookies from the client
}));


app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'none'

  }
}));
// Serve static files if you have them (for production builds, etc.)
//app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// Store user data in memory (use a database in production)
let userData = {};

/**
 * Step 1: Facebook Login - Redirect to Facebook OAuth
 */
app.get('/auth/facebook', (req, res) => {
  const redirectUri = `https://www.facebook.com/v21.0/dialog/oauth?client_id=2343862285947895&redirect_uri=https://meta-ad-uploader-server-production.up.railway.app/auth/callback&scope=ads_read,ads_management,business_management,pages_show_list&response_type=code`;
  res.redirect(redirectUri);
});

/**
 * Step 2: Handle Facebook OAuth Callback
 */
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing' });
  }

  try {
    // Exchange the authorization code for an access token
    const tokenResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: 'https://meta-ad-uploader-server-production.up.railway.app/auth/callback',
        code: code
      }
    });

    const { access_token } = tokenResponse.data;
    req.session.accessToken = access_token;



    userData.accessToken = access_token;
    // Redirect back to your React app. 
    // Adjust the URL/port to wherever your React dev server is running.
    res.redirect('https://batchadupload.vercel.app/?loggedIn=true');
  } catch (error) {
    console.error('OAuth Callback Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to complete Facebook Login' });
  }
});

/**
 * Fetch Ad Accounts
 */
app.get('/auth/fetch-ad-accounts', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    const adAccountsResponse = await axios.get('https://graph.facebook.com/v21.0/me/adaccounts', {
      params: {
        access_token: token,
        fields: 'id,account_id,name'
      }
    });

    const adAccounts = adAccountsResponse.data.data;
    userData.adAccounts = adAccounts; // optional storage

    res.json({
      success: true,
      adAccounts
    });
  } catch (error) {
    console.error('Fetch Ad Accounts Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch ad accounts' });
  }
});

/**
 * Fetch Campaigns for a given Ad Account
 *   GET /auth/fetch-campaigns?adAccountId=act_XXXX
 */
app.get('/auth/fetch-campaigns', async (req, res) => {
  const { adAccountId } = req.query;
  const token = req.session.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  if (!adAccountId) {
    return res.status(400).json({ error: 'Missing adAccountId parameter' });
  }

  try {
    const campaignsUrl = `https://graph.facebook.com/v21.0/${adAccountId}/campaigns`;
    const campaignsResponse = await axios.get(campaignsUrl, {
      params: {
        access_token: token,
        fields: 'id,name,status'
      }
    });

    res.json({
      campaigns: campaignsResponse.data.data
    });
  } catch (error) {
    console.error('Fetch Campaigns Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * Fetch Ad Sets for a given Campaign
 *   GET /auth/fetch-adsets?campaignId=123456
 */
app.get('/auth/fetch-adsets', async (req, res) => {
  const { campaignId } = req.query;
  const token = req.session.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  if (!campaignId) {
    return res.status(400).json({ error: 'Missing campaignId parameter' });
  }

  try {
    const adSetsUrl = `https://graph.facebook.com/v21.0/${campaignId}/adsets`;
    const adSetsResponse = await axios.get(adSetsUrl, {
      params: {
        access_token: token,
        fields: 'id,name,status'
      }
    });

    res.json({
      adSets: adSetsResponse.data.data
    });
  } catch (error) {
    console.error('Fetch Ad Sets Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch ad sets' });
  }
});

app.get('/auth/fetch-pages', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  try {
    // The /me/accounts endpoint returns Pages that the user manages
    const pagesResponse = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token: token,
        fields: 'id,name,access_token'
      }
    });
    const pages = pagesResponse.data.data;
    res.json({ success: true, pages });
  } catch (error) {
    console.error('Error fetching pages:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
});


/**
 * (NEW) Create an Ad in a given Ad Set
 *   POST /auth/create-ad
 *   Body: { adSetId, pageId, link, message, caption, cta, imageUrl }
 */
app.post('/auth/create-ad', upload.single('imageFile'), async (req, res) => {

  const token = req.session.accessToken;
  try {
    if (!token) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // We expect these fields in multipart form data
    const {
      adName,
      headline,
      description,
      adSetId,
      pageId,
      link,
      message,
      caption,
      cta
    } = req.body; // normal text fields

    // The file will be in req.file
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No image file received' });
    }

    // (A) Derive or get the Ad Account ID
    // Option 1: Pass it from the front end in formData (then it's in req.body.adAccountId).
    // Option 2: Extract from adSetId if it looks like act_<ID>...
    // For simplicity, let's assume user also included adAccountId in the form:
    const { adAccountId } = req.body;
    if (!adAccountId) {
      return res.status(400).json({ error: 'Missing adAccountId' });
    }

    // 1) Upload the image to the Meta Marketing API
    // POST /act_<AD_ACCOUNT_ID>/adimages with file data
    if (file.mimetype.startsWith('video/')) {
      const uploadVideoUrl = `https://graph.facebook.com/v21.0/act_${adAccountId}/advideos`;

      // Use FormData for video upload
      const videoFormData = new FormData();
      videoFormData.append('access_token', req.session.accessToken);
      // Note: Some endpoints expect the file parameter to be named 'source'
      videoFormData.append('source', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype
      });

      const videoUploadResponse = await axios.post(uploadVideoUrl, videoFormData, {
        headers: videoFormData.getHeaders()
      });

      const videoId = videoUploadResponse.data.id;

      // 2. Create video ad creative payload using video_data
      const createAdData = {
        name: adName,
        adset_id: adSetId,
        creative: {
          object_story_spec: {
            page_id: pageId,
            video_data: {
              video_id: videoId,
              call_to_action: {
                type: cta,
                value: {
                  link: link
                }
              },
              message: message,
              title: headline,
              description: description
            }
          },
          degrees_of_freedom_spec: {
            creative_features_spec: {
              standard_enhancements: {
                enroll_status: "OPT_OUT"
              }
            }
          }
        },
        status: 'PAUSED'
      };

      // Post the ad creative using the video ad data
      const createAdUrl = `https://graph.facebook.com/v21.0/act_${adAccountId}/ads`;
      const createAdResponse = await axios.post(createAdUrl, createAdData, {
        params: { access_token: req.session.accessToken }
      });
      return res.json(createAdResponse.data);
    }
    else {
      const uploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;

      // Build multipart form data for the file
      const formData = new FormData();
      formData.append('access_token', token);
      formData.append('file', req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype
      });
      // Send the request to Facebook
      const uploadResponse = await axios.post(uploadUrl, formData, {
        headers: formData.getHeaders()
      });

      // The response should have "images": { "<filename>": { "hash": "..."} }
      const imagesInfo = uploadResponse.data.images;
      const filenameKey = Object.keys(imagesInfo)[0]; // we only uploaded 1 file
      const imageHash = imagesInfo[filenameKey].hash;

      // 2) Now create the ad on the chosen ad set:
      // POST /<adSetId>/ads with the object_story_spec referencing image_hash
      const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
      const createAdData = {
        name: adName,
        adset_id: adSetId,
        creative: {
          object_story_spec: {
            page_id: pageId,
            link_data: {
              name: headline,          // Displayed headline
              description: description,
              call_to_action: {
                type: cta,
                value: {
                  link: link
                }
              },
              message: message,
              link: link,
              caption: caption,
              // Use the uploaded image hash
              image_hash: imageHash
            }
          },
          degrees_of_freedom_spec: {
            creative_features_spec: {
              standard_enhancements: {
                enroll_status: "OPT_OUT"  // or "OPT_OUT" if you prefer to disable standard enhancements
              }
            }
          }
        },
        status: 'PAUSED'
      };

      const createAdResponse = await axios.post(createAdUrl, createAdData, {
        params: {
          access_token: token
        }
      });

      // Respond with the newly created Ad info
      res.json(createAdResponse.data);
    }
  } catch (error) {
    console.error('Create Ad Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to create ad' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
