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
const { db } = require("./firebase");


// Parse JSON bodies
app.use(express.json());
app.set('trust proxy', 1);

app.use(cors({
  origin: 'https://batchadupload.vercel.app', // Replace with your React app's origin
  credentials: true // This enables sending cookies from the client
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

// Multer disk storage
const uploadDir = path.join('/data', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// In-memory user storage (use a database in production)
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
// app.get('/auth/callback', async (req, res) => {
//   const { code } = req.query;
//   if (!code) {
//     return res.status(400).json({ error: 'Authorization code missing' });
//   }
//   try {
//     // Exchange the authorization code for an access token
//     const tokenResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
//       params: {
//         client_id: process.env.META_APP_ID,
//         client_secret: process.env.META_APP_SECRET,
//         redirect_uri: 'https://meta-ad-uploader-server-production.up.railway.app/auth/callback',
//         code: code
//       }
//     });
//     const { access_token: shortLivedToken } = tokenResponse.data;
//     const longLivedResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
//       params: {
//         grant_type: 'fb_exchange_token',
//         client_id: process.env.META_APP_ID,
//         client_secret: process.env.META_APP_SECRET,
//         fb_exchange_token: shortLivedToken
//       }
//     });
//     const { access_token: longLivedToken } = longLivedResponse.data;
//     req.session.accessToken = longLivedToken;
//     userData.accessToken = longLivedToken;
//     req.session.user = {
//       name: (await axios.get('https://graph.facebook.com/v21.0/me', {
//         params: {
//           access_token: longLivedToken,
//           fields: 'name'
//         }
//       })).data.name
//     };
//     res.redirect('https://batchadupload.vercel.app/?loggedIn=true');
//   } catch (error) {
//     console.error('OAuth Callback Error:', error.response?.data || error.message);
//     res.status(500).json({ error: 'Failed to complete Facebook Login' });
//   }
// });


app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing' });
  }

  try {
    // 1. Exchange for short-lived token
    const tokenResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: 'https://meta-ad-uploader-server-production.up.railway.app/auth/callback',
        code: code
      }
    });

    const { access_token: shortLivedToken } = tokenResponse.data;

    // 2. Exchange for long-lived token
    const longLivedResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });

    const { access_token: longLivedToken } = longLivedResponse.data;

    // 3. Store token in session + fetch user info
    req.session.accessToken = longLivedToken;
    userData.accessToken = longLivedToken;

    const meResponse = await axios.get('https://graph.facebook.com/v21.0/me', {
      params: {
        access_token: longLivedToken,
        fields: 'id,name,email'
      }
    });

    const { id: facebookId, name, email } = meResponse.data;

    req.session.user = { name };

    // ✅ 4. Firestore Integration — add or update user
    const userRef = db.collection("users").doc(facebookId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        name,
        email: email || null,
        accessToken: longLivedToken,
        createdAt: new Date(),
        hasCompletedSignup: true,
        preferences: {
          checkboxA: false,
          dropdownValue: "default",
          textField: ""
        }
      });
      console.log("New user added to Firestore:", facebookId);
    } else {
      await userRef.update({ accessToken: longLivedToken });
      console.log("User already existed, token updated:", facebookId);
    }

    // 5. Final redirect
    res.redirect('https://batchadupload.vercel.app/?loggedIn=true');

  } catch (error) {
    console.error('OAuth Callback Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to complete Facebook Login' });
  }
});


/**
 * Fetch Ad Accounts
 */
// app.get('/auth/me', (req, res) => {
//   if (req.session && req.session.user) {
//     res.json({ user: req.session.user });
//   } else {
//     res.status(401).json({ error: 'Not authenticated' });
//   }
// });

app.get("/auth/me", async (req, res) => {
  const { userId } = req.session;

  // Not logged in
  if (!userId) {
    return res.json({ loggedIn: false });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return res.json({ loggedIn: false });
    }

    const userData = userDoc.data();

    res.json({
      loggedIn: true,
      user: {
        name: userData.name,
        email: userData.email,
        hasCompletedSignup: userData.hasCompletedSignup,
        preferences: userData.preferences || {},
      },
    });
  } catch (err) {
    console.error("Error fetching user from Firestore:", err);
    res.status(500).json({ loggedIn: false, error: "Internal server error" });
  }
});

app.get('/auth/fetch-ad-accounts', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });
  try {
    const adAccountsResponse = await axios.get('https://graph.facebook.com/v21.0/me/adaccounts', {
      params: {
        access_token: token,
        fields: 'id,account_id,name'
      }
    });
    const adAccounts = adAccountsResponse.data.data;
    userData.adAccounts = adAccounts;
    res.json({ success: true, adAccounts });
  } catch (error) {
    console.error('Fetch Ad Accounts Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch ad accounts' });
  }
});

/**
 * Fetch Campaigns for a given Ad Account
 */
app.get('/auth/fetch-campaigns', async (req, res) => {
  const { adAccountId } = req.query;
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });
  if (!adAccountId) return res.status(400).json({ error: 'Missing adAccountId parameter' });
  try {
    const campaignsUrl = `https://graph.facebook.com/v21.0/${adAccountId}/campaigns`;
    const campaignsResponse = await axios.get(campaignsUrl, {
      params: {
        access_token: token,
        fields: 'id,name,status,objective'
      }
    });
    res.json({ campaigns: campaignsResponse.data.data });
  } catch (error) {
    console.error('Fetch Campaigns Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

/**
 * Fetch Ad Sets for a given Campaign
 */
app.get('/auth/fetch-adsets', async (req, res) => {
  const { campaignId } = req.query;
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId parameter' });
  try {
    const adSetsUrl = `https://graph.facebook.com/v21.0/${campaignId}/adsets`;
    const adSetsResponse = await axios.get(adSetsUrl, {
      params: {
        access_token: token,
        fields: 'id,name,status,is_dynamic_creative,destination_type'
      }
    });
    res.json({ adSets: adSetsResponse.data.data });
  } catch (error) {
    console.error('Fetch Ad Sets Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch ad sets' });
  }
});

app.post('/auth/duplicate-adset', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });
  const { adSetId, campaignId, adAccountId } = req.body;
  if (!adSetId || !campaignId || !adAccountId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  try {
    const copyUrl = `https://graph.facebook.com/v21.0/${adSetId}/copies`;
    const params = {
      campaign_id: campaignId,
      rename_options: JSON.stringify({ rename_suffix: '_02' }),
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
  if (!token) return res.status(401).json({ error: 'User not authenticated' });
  try {
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
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Helper: Poll video processing status
async function waitForVideoProcessing(videoId, token) {
  const maxWaitTime = 300000; // 5 minutes
  const pollInterval = 5000;  // 5 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const videoStatusUrl = `https://graph.facebook.com/v21.0/${videoId}`;
    const statusResponse = await axios.get(videoStatusUrl, {
      params: {
        access_token: token,
        fields: 'status'
      }
    });
    const videoStatus = statusResponse.data.status && statusResponse.data.status.video_status;
    if (videoStatus === 'ready') return;
    if (videoStatus === 'failed') throw new Error('Video processing failed');
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error('Video processing timed out');
}

// Helper: Build video creative payload
function buildVideoCreativePayload({ adName, adSetId, pageId, videoId, cta, link, headlines, messagesArray, descriptionsArray, thumbnailHash, useDynamicCreative }) {
  if (useDynamicCreative) {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: { page_id: pageId },
        asset_feed_spec: {
          videos: [{ video_id: videoId, thumbnail_hash: thumbnailHash }],
          titles: headlines.map(text => ({ text })),
          bodies: messagesArray.map(text => ({ text })),
          descriptions: descriptionsArray.map(text => ({ text })),
          ad_formats: ["SINGLE_VIDEO"],
          call_to_action_types: [cta],
          link_urls: [{ website_url: link }]
        },
        degrees_of_freedom_spec: {
          creative_features_spec: {
            standard_enhancements: { enroll_status: "OPT_OUT" }
          }
        }
      },
      status: 'ACTIVE'
    };
  } else {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: {
          page_id: pageId,
          video_data: {
            video_id: videoId,
            call_to_action: { type: cta, value: { link } },
            message: messagesArray[0],
            title: headlines[0],
            link_description: descriptionsArray[0],
            image_hash: thumbnailHash
          }
        },
        degrees_of_freedom_spec: {
          creative_features_spec: {
            standard_enhancements: { enroll_status: "OPT_OUT" }
          }
        }
      },
      status: 'ACTIVE'
    };
  }
}

// Helper: Build image creative payload
function buildImageCreativePayload({ adName, adSetId, pageId, imageHash, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative }) {
  if (useDynamicCreative) {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: { page_id: pageId },
        asset_feed_spec: {
          images: [{ hash: imageHash }],
          titles: headlines.map(text => ({ text })),
          bodies: messagesArray.map(text => ({ text })),
          descriptions: descriptionsArray.map(text => ({ text })),
          ad_formats: ["SINGLE_IMAGE"],
          call_to_action_types: [cta],
          link_urls: [{ website_url: link }]
        },
        degrees_of_freedom_spec: {
          creative_features_spec: {
            standard_enhancements: { enroll_status: "OPT_OUT" }
          }
        }
      },
      status: 'ACTIVE'
    };
  } else {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: {
          page_id: pageId,
          link_data: {
            name: headlines[0],
            description: descriptionsArray[0],
            call_to_action: { type: cta, value: { link } },
            message: messagesArray[0],
            link: link,
            caption: link,
            image_hash: imageHash
          }
        },
        degrees_of_freedom_spec: {
          creative_features_spec: {
            standard_enhancements: { enroll_status: "OPT_OUT" }
          }
        }
      },
      status: 'ACTIVE'
    };
  }
}

// Helper: Handle Video Ad Creation
async function handleVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative) {
  const file = req.files.imageFile && req.files.imageFile[0];
  const uploadVideoUrl = `https://graph.facebook.com/v21.0/${adAccountId}/advideos`;

  const videoFormData = new FormData();
  videoFormData.append('access_token', token);
  videoFormData.append('source', fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype
  });
  const videoUploadResponse = await axios.post(uploadVideoUrl, videoFormData, {
    headers: videoFormData.getHeaders()
  });
  const videoId = videoUploadResponse.data.id;

  // Wait for processing only if dynamic creative is used
  if (useDynamicCreative) {
    await waitForVideoProcessing(videoId, token);
  }

  const thumbnailFile = req.files.thumbnail && req.files.thumbnail[0];
  if (!thumbnailFile) {
    throw new Error('Thumbnail file is required for video ads');
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

  const creativePayload = buildVideoCreativePayload({
    adName,
    adSetId,
    pageId,
    videoId,
    cta,
    link,
    headlines,
    messagesArray,
    descriptionsArray,
    thumbnailHash,
    useDynamicCreative
  });
  const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, {
    params: { access_token: token }
  });

  // Cleanup files
  fs.unlink(file.path, err => {
    if (err) console.error("Error deleting video file:", err);
    else console.log("Video file deleted:", file.path);
  });
  fs.unlink(thumbnailFile.path, err => {
    if (err) console.error("Error deleting thumbnail file:", err);
    else console.log("Thumbnail file deleted:", thumbnailFile.path);
  });

  return createAdResponse.data;
}

// Helper: Handle Image Ad Creation
async function handleImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative) {
  const file = req.files.imageFile && req.files.imageFile[0];
  const uploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;

  const formData = new FormData();
  formData.append('access_token', token);
  formData.append('file', fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype
  });
  const uploadResponse = await axios.post(uploadUrl, formData, {
    headers: formData.getHeaders()
  });
  const imagesInfo = uploadResponse.data.images;
  const filenameKey = Object.keys(imagesInfo)[0];
  const imageHash = imagesInfo[filenameKey].hash;

  const creativePayload = buildImageCreativePayload({
    adName,
    adSetId,
    pageId,
    imageHash,
    cta,
    link,
    headlines,
    messagesArray,
    descriptionsArray,
    useDynamicCreative
  });
  const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, {
    params: { access_token: token }
  });

  fs.unlink(file.path, err => {
    if (err) console.error("Error deleting image file:", err);
    else console.log("Image file deleted:", file.path);
  });

  return createAdResponse.data;
}

/**
 * (NEW) Create an Ad in a given Ad Set
 */
app.post(
  '/auth/create-ad',
  upload.fields([
    { name: 'mediaFiles', maxCount: 10 },      // For dynamic creative (multiple files)
    { name: 'thumbnails', maxCount: 1 },        // For dynamic creative video thumbnails
    { name: 'imageFile', maxCount: 1 },          // For non-dynamic creative (single file)
    { name: 'thumbnail', maxCount: 1 }           // For non-dynamic creative video thumbnail
  ]),
  async (req, res) => {
    const token = req.session.accessToken;
    if (!token) return res.status(401).json({ error: 'User not authenticated' });

    try {
      // Extract basic fields and parse creative text fields.
      const { adName, adSetId, pageId, link, cta, adAccountId } = req.body;
      if (!adAccountId) return res.status(400).json({ error: 'Missing adAccountId' });

      const parseField = (field, fallback) => {
        try { return JSON.parse(field); } catch (e) { return fallback ? [fallback] : []; }
      };
      const headlines = parseField(req.body.headlines, req.body.headline);
      const descriptionsArray = parseField(req.body.descriptions, req.body.description);
      const messagesArray = parseField(req.body.messages, req.body.message);

      // Fetch the ad set info to determine dynamic creative.
      const adSetInfoUrl = `https://graph.facebook.com/v21.0/${adSetId}`;
      const adSetInfoResponse = await axios.get(adSetInfoUrl, {
        params: { access_token: token, fields: 'is_dynamic_creative' }
      });
      const adSetDynamicCreative = adSetInfoResponse.data.is_dynamic_creative;
      const useDynamicCreative =
        headlines.length > 1 ||
        descriptionsArray.length > 1 ||
        messagesArray.length > 1 ||
        adSetDynamicCreative;

      let result;
      // For dynamic ad creative, use the aggregated media fields.
      if (useDynamicCreative) {
        // Expect the aggregated files to be in req.files.mediaFiles
        const mediaFiles = req.files.mediaFiles;
        if (!mediaFiles || mediaFiles.length === 0) {
          return res.status(400).json({ error: 'No media files received for dynamic creative' });
        }
        // Decide if these are videos or images (assumes all files are of the same type)
        if (mediaFiles[0].mimetype.startsWith('video/')) {
          result = await handleDynamicVideoAd(
            req,
            token,
            adAccountId,
            adSetId,
            pageId,
            adName,
            cta,
            link,
            headlines,
            messagesArray,
            descriptionsArray
          );
        } else {
          result = await handleDynamicImageAd(
            req,
            token,
            adAccountId,
            adSetId,
            pageId,
            adName,
            cta,
            link,
            headlines,
            messagesArray,
            descriptionsArray
          );
        }
      } else {
        // Non-dynamic creative: use the original single file fields.
        const file = req.files.imageFile && req.files.imageFile[0];
        if (!file) return res.status(400).json({ error: 'No image file received' });
        if (file.mimetype.startsWith('video/')) {
          result = await handleVideoAd(
            req,
            token,
            adAccountId,
            adSetId,
            pageId,
            adName,
            cta,
            link,
            headlines,
            messagesArray,
            descriptionsArray,
            useDynamicCreative
          );
        } else {
          result = await handleImageAd(
            req,
            token,
            adAccountId,
            adSetId,
            pageId,
            adName,
            cta,
            link,
            headlines,
            messagesArray,
            descriptionsArray,
            useDynamicCreative
          );
        }
      }
      return res.json(result);
    } catch (error) {
      console.error('Create Ad Error:', error.response?.data || error.message);
      const fbErrorMsg = error.response?.data?.error?.error_user_msg || error.message || 'Failed to create ad';
      return res.status(400).send(fbErrorMsg);
    }
  }
);

// Helper: Process multiple images for dynamic creative.
async function handleDynamicImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray) {
  const mediaFiles = req.files.mediaFiles;
  let imageHashes = [];
  for (const file of mediaFiles) {
    const uploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;
    const formData = new FormData();
    formData.append('access_token', token);
    formData.append('file', fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype
    });
    const uploadResponse = await axios.post(uploadUrl, formData, {
      headers: formData.getHeaders()
    });
    const imagesInfo = uploadResponse.data.images;
    const key = Object.keys(imagesInfo)[0];
    imageHashes.push({ hash: imagesInfo[key].hash });
    await fs.promises.unlink(file.path).catch(err => console.error("Error deleting image file:", err));
  }
  const assetFeedSpec = {
    images: imageHashes,
    titles: headlines.map(text => ({ text })),
    bodies: messagesArray.map(text => ({ text })),
    descriptions: descriptionsArray.map(text => ({ text })),
    ad_formats: ["SINGLE_IMAGE"],
    call_to_action_types: [cta],
    link_urls: [{ website_url: link }]
  };
  const creativePayload = {
    name: adName,
    adset_id: adSetId,
    creative: {
      object_story_spec: { page_id: pageId },
      asset_feed_spec: assetFeedSpec,
      degrees_of_freedom_spec: {
        creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } }
      }
    },
    status: 'ACTIVE'
  };
  const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, { params: { access_token: token } });
  return createAdResponse.data;
}

// Helper: Process multiple videos for dynamic creative.
async function handleDynamicVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray) {
  const mediaFiles = req.files.mediaFiles;
  const thumbFile = req.files.thumbnail && req.files.thumbnail[0];
  if (!thumbFile) {
    throw new Error("Thumbnail file is required for dynamic video ads");
  }

  let videoAssets = [];
  for (let i = 0; i < mediaFiles.length; i++) {
    const file = mediaFiles[i];
    const uploadVideoUrl = `https://graph.facebook.com/v21.0/${adAccountId}/advideos`;
    const videoFormData = new FormData();
    videoFormData.append('access_token', token);
    videoFormData.append('source', fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype
    });
    const videoUploadResponse = await axios.post(uploadVideoUrl, videoFormData, {
      headers: videoFormData.getHeaders()
    });
    const videoId = videoUploadResponse.data.id;
    await waitForVideoProcessing(videoId, token);

    // Use the same thumbFile for every video:
    const thumbFormData = new FormData();
    thumbFormData.append('access_token', token);
    thumbFormData.append('file', fs.createReadStream(thumbFile.path), {
      filename: thumbFile.originalname,
      contentType: thumbFile.mimetype
    });
    const thumbUploadUrl = `https://graph.facebook.com/v21.0/${adAccountId}/adimages`;
    const thumbUploadResponse = await axios.post(thumbUploadUrl, thumbFormData, {
      headers: thumbFormData.getHeaders()
    });
    const imagesInfo = thumbUploadResponse.data.images;
    const key = Object.keys(imagesInfo)[0];
    videoAssets.push({ video_id: videoId, thumbnail_hash: imagesInfo[key].hash });

    // Clean up video file after processing
    await fs.promises.unlink(file.path).catch(err => console.error("Error deleting video file:", err));
  }

  // Clean up the single thumbnail file after all videos have been processed
  await fs.promises.unlink(thumbFile.path).catch(err => console.error("Error deleting thumbnail file:", err));

  const assetFeedSpec = {
    videos: videoAssets,
    titles: headlines.map(text => ({ text })),
    bodies: messagesArray.map(text => ({ text })),
    descriptions: descriptionsArray.map(text => ({ text })),
    ad_formats: ["SINGLE_VIDEO"],
    call_to_action_types: [cta],
    link_urls: [{ website_url: link }]
  };
  const creativePayload = {
    name: adName,
    adset_id: adSetId,
    creative: {
      object_story_spec: { page_id: pageId },
      asset_feed_spec: assetFeedSpec,
      degrees_of_freedom_spec: {
        creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } }
      }
    },
    status: 'ACTIVE'
  };
  const createAdUrl = `https://graph.facebook.com/v21.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, { params: { access_token: token } });
  return createAdResponse.data;
}


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
