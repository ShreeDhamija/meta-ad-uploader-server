const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const session = require('express-session');
const dotenvResult = require('dotenv').config();
const fs = require('fs');
const path = require('path');
const app = express();

// Parse JSON bodies
app.use(express.json());
app.set('trust proxy', 1);

app.use(cors({
  origin: 'https://batchadupload.vercel.app', // Replace with your React app's origin
  credentials: true               // This enables sending cookies from the client
}));

app.use(express.static('public'));

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


//multer discStorage
const uploadDir = path.join('/data', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
// Serve static files if you have them (for production builds, etc.)
//app.use(express.static(path.join(__dirname, 'public')));
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Save files to the persistent uploads folder
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Create a unique filename (e.g., fieldname-timestamp-random.ext)
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });


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

    const { access_token: shortLivedToken } = tokenResponse.data;
    const longLivedResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });
    const { access_token: longLivedToken } = longLivedResponse.data;

    // Store the long-lived token in the session (and any in-memory storage you use).
    req.session.accessToken = longLivedToken;
    userData.accessToken = longLivedToken;

    // Store the access token in the session
    req.session.accessToken = longLivedToken;

    // Fetch the user's profile (for example, just the name)
    const profileResponse = await axios.get('https://graph.facebook.com/v21.0/me', {
      params: {
        access_token: longLivedToken,
        fields: 'name'
      }
    });
    const userName = profileResponse.data.name;

    // Store user data in session (you could add more fields as needed)
    req.session.user = { name: userName };
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

app.get('/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});


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
        fields: 'id,name,status,objective'
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
        fields: 'id,name,status,is_dynamic_creative,destination_type'
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

app.post('/auth/duplicate-adset', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  const { adSetId, campaignId, adAccountId } = req.body;
  if (!adSetId || !campaignId || !adAccountId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // Use the /{ad_set_id}/copies edge to duplicate the ad set.
    const copyUrl = `https://graph.facebook.com/v21.0/${adSetId}/copies`;
    const params = {
      campaign_id: campaignId,            // The campaign to place the duplicate in.
      rename_options: JSON.stringify({
        rename_suffix: '_02'
      }),
      access_token: token,
    };

    const copyResponse = await axios.post(copyUrl, null, { params });
    return res.json(copyResponse.data);
  } catch (error) {
    console.error('Duplicate adSet error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to duplicate adSet' });
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

app.get('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }
    // Clear the session cookie. Adjust the cookie name if necessary.
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});


// Helper function to poll the video processing status
async function waitForVideoProcessing(videoId, token) {
  const maxWaitTime = 300000; // 5 minutes in milliseconds
  const pollInterval = 5000; // Poll every 5 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    // Call the video endpoint to get the status
    const videoStatusUrl = `https://graph.facebook.com/v21.0/${videoId}`;
    const statusResponse = await axios.get(videoStatusUrl, {
      params: {
        access_token: token,
        fields: 'status'
      }
    });
    const videoStatus = statusResponse.data.status.video_status;
    if (videoStatus === 'ready') {
      return; // Video is processed
    } else if (videoStatus === 'failed') {
      throw new Error('Video processing failed');
    }
    // Wait for the poll interval before checking again
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error('Video processing timed out');
}


/**
 * (NEW) Create an Ad in a given Ad Set
 *   POST /auth/create-ad
 *   Body: { adSetId, pageId, link, message, caption, cta, imageUrl }
 */
app.post('/auth/create-ad', upload.fields([{ name: 'imageFile', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {

  const token = req.session.accessToken;
  try {
    if (!token) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // We expect these fields in multipart form data
    const {
      adName,
      // headline,
      // description,
      //message,
      adSetId,
      pageId,
      link,
      //caption,
      cta
    } = req.body; // normal text fields


    let headlines = [];
    let descriptionsArray = [];
    let messagesArray = [];

    try {
      headlines = JSON.parse(req.body.headlines);
    } catch (e) {
      headlines = req.body.headline ? [req.body.headline] : [];
    }
    try {
      descriptionsArray = JSON.parse(req.body.descriptions);
    } catch (e) {
      descriptionsArray = req.body.description ? [req.body.description] : [];
    }
    try {
      messagesArray = JSON.parse(req.body.messages);
    } catch (e) {
      messagesArray = req.body.message ? [req.body.message] : [];
    }



    // Fetch the ad set info to retrieve the is_dynamic_creative field
    const adSetInfoUrl = `https://graph.facebook.com/v21.0/${adSetId}`;
    const adSetInfoResponse = await axios.get(adSetInfoUrl, {
      params: {
        access_token: token,
        fields: 'is_dynamic_creative'
      }
    });
    const adSetDynamicCreative = adSetInfoResponse.data.is_dynamic_creative;

    const useDynamicCreative =
      headlines.length > 1 || descriptionsArray.length > 1 || messagesArray.length > 1 || adSetDynamicCreative;

    // The file will be in req.file
    const file = req.files.imageFile && req.files.imageFile[0];
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
      const uploadVideoUrl = `https://graph.facebook.com/v21.0/${adAccountId}/advideos`;

      // Use FormData for video upload
      const videoFormData = new FormData();
      videoFormData.append('access_token', req.session.accessToken);
      // Note: Some endpoints expect the file parameter to be named 'source'
      videoFormData.append('source', fs.createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype
      });

      const videoUploadResponse = await axios.post(uploadVideoUrl, videoFormData, {
        headers: videoFormData.getHeaders()
      });


      //create thumbnail hash
      const videoId = videoUploadResponse.data.id;
      // Only for dynamic creative, wait for the video to be processed
      if (useDynamicCreative) {
        await waitForVideoProcessing(videoId, token);
      }
      const thumbnailFile = req.files.thumbnail && req.files.thumbnail[0];
      if (!thumbnailFile) {
        return res.status(400).json({ error: 'Thumbnail file is required for video ads' });
      }
      const thumbFormData = new FormData();
      thumbFormData.append('access_token', token);
      thumbFormData.append('file', fs.createReadStream(thumbnailFile.path), {
        filename: thumbnailFile.originalname,
        contentType: thumbnailFile.mimetype
      });
      const thumbUploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;
      const thumbUploadResponse = await axios.post(thumbUploadUrl, thumbFormData, {
        headers: thumbFormData.getHeaders()
      });
      const imagesInfo = thumbUploadResponse.data.images;
      const thumbKey = Object.keys(imagesInfo)[0];
      const thumbnailHash = imagesInfo[thumbKey].hash;

      const assetFeedSpec = {
        videos: [{ video_id: videoId, thumbnail_hash: thumbnailHash }],
        titles: headlines.map(text => ({ text })),
        bodies: messagesArray.map(text => ({ text })),
        descriptions: descriptionsArray.map(text => ({ text })),
        ad_formats: ["SINGLE_VIDEO"], // or appropriate formats
        call_to_action_types: [cta],    // e.g., "SHOP_NOW"
        link_urls: [{ website_url: link }]
      };
      // 2. Create video ad creative payload using video_data
      let createAdData;
      if (useDynamicCreative) {
        createAdData = {
          name: adName,
          adset_id: adSetId,
          creative: {
            object_story_spec: {
              page_id: pageId,
            },
            asset_feed_spec: assetFeedSpec,
            degrees_of_freedom_spec: {
              creative_features_spec: {
                standard_enhancements: {
                  enroll_status: "OPT_OUT"
                }
              }
            }
          },
          status: 'ACTIVE'
        };
      }
      else {
        createAdData = {
          name: adName,
          adset_id: adSetId,
          creative: {
            object_story_spec: {
              page_id: pageId,
              video_data: {
                video_id: videoId,
                call_to_action: {
                  type: cta,
                  value: { link }
                },
                // Note: Using the single value from each array
                message: messagesArray[0],
                title: headlines[0],
                link_description: descriptionsArray[0],
                image_hash: thumbnailHash,
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
          status: 'ACTIVE'
        };
      }


      // Post the ad creative using the video ad data
      const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
      const createAdResponse = await axios.post(createAdUrl, createAdData, {
        params: { access_token: req.session.accessToken }
      });

      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting video file:", err);
        else console.log("Video file deleted:", file.path);
      });
      fs.unlink(thumbnailFile.path, (err) => {
        if (err) console.error("Error deleting thumbnail file:", err);
        else console.log("Thumbnail file deleted:", thumbnailFile.path);
      });
      return res.json(createAdResponse.data);
    }
    else {
      const uploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;

      // Build multipart form data for the file
      const formData = new FormData();
      formData.append('access_token', token);
      formData.append('file', fs.createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype
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
      const assetFeedSpec = {
        images: [{ hash: imageHash }],
        titles: headlines.map(text => ({ text })),
        bodies: messagesArray.map(text => ({ text })),
        descriptions: descriptionsArray.map(text => ({ text })),
        ad_formats: ["SINGLE_IMAGE"], // or appropriate formats
        call_to_action_types: [cta],    // e.g., "SHOP_NOW"
        link_urls: [{ website_url: link }]
      };
      // 2. Create video ad creative payload using video_data
      let createAdData;
      if (useDynamicCreative) {
        createAdData = {
          name: adName,
          adset_id: adSetId,
          creative: {
            object_story_spec: {
              page_id: pageId,
            },
            asset_feed_spec: assetFeedSpec,
            degrees_of_freedom_spec: {
              creative_features_spec: {
                standard_enhancements: {
                  enroll_status: "OPT_OUT"
                }
              }
            }
          },
          status: 'ACTIVE'
        };
      }
      else {
        createAdData = {
          name: adName,
          adset_id: adSetId,
          creative: {
            object_story_spec: {
              page_id: pageId,
              link_data: {
                name: headlines[0],
                description: descriptionsArray[0],
                call_to_action: {
                  type: cta,
                  value: { link }
                },
                message: messagesArray[0],
                link: link,
                caption: link,
                image_hash: imageHash
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
          status: 'ACTIVE'
        };
      }


      const createAdResponse = await axios.post(createAdUrl, createAdData, {
        params: {
          access_token: token
        }
      });
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting image file:", err);
        else console.log("Image file deleted:", file.path);
      });
      // Respond with the newly created Ad info
      res.json(createAdResponse.data);
    }
  } catch (error) {
    console.error('Create Ad Error:', error.response?.data || error.message);
    const fbErrorMsg = error.response?.data?.error?.error_user_msg || 'Failed to create ad';
    console.log(error.response?.data?.error?.error_user_msg || 'Failed to create ad');
    return res.status(400).send(fbErrorMsg);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
