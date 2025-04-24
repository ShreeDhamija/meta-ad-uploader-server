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
const {
  createOrUpdateUser,
  getUserByFacebookId,
  saveGlobalSettings,
  saveAdAccountSettings,
  getGlobalSettings,
  getAdAccountSettings,
  deleteCopyTemplate,
} = require("./firebaseController");
const { createClient } = require('redis');
const { RedisStore } = require('connect-redis');

app.use(express.json());
app.set('trust proxy', 1);
app.use(cors({
  origin: 'https://batchadupload.vercel.app', // Replace with your React app's origin
  credentials: true // This enables sending cookies from the client
}));
app.use(express.static('public'));


const STATIC_LOGIN = {
  username: "metatest",
  password: "password", // ideally use env variable
};

const redisClient = createClient({
  url: "rediss://default:AW3HAAIjcDE4ZjhlZWE5ZjAwOGI0N2VmYWZlNjhlYmIxYTBmNTY2NnAxMA@cuddly-crab-28103.upstash.io:6379"
});
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('ready', () => {
  console.log('✅ Redis client is ready');
});

(async () => {
  try {
    await redisClient.connect();

    app.use(session({
      store: new RedisStore({ client: redisClient }),
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

    app.get('/', (req, res) => {
      req.session.viewCount = (req.session.viewCount || 0) + 1;
      res.send(`Viewed ${req.session.viewCount} times`);
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error('Failed to connect Redis:', err);
    process.exit(1);
  }
})();


// app.use(session({
//   secret: process.env.SESSION_SECRET || 'your-secret-key',
//   resave: false,
//   saveUninitialized: false,
//   cookie: {
//     secure: process.env.NODE_ENV === 'production',
//     httpOnly: true,
//     maxAge: 24 * 60 * 60 * 1000, // 24 hours
//     sameSite: 'none'
//   }
// }));




function buildCreativeEnhancementsConfig(firestoreSettings = {}) {
  return {
    image_brightness_and_contrast: {
      enroll_status: firestoreSettings.brightness ? "OPT_IN" : "OPT_OUT"
    },
    enhance_CTA: {
      enroll_status: firestoreSettings.cta ? "OPT_IN" : "OPT_OUT"
    },
    image_templates: {
      enroll_status: firestoreSettings.overlay ? "OPT_IN" : "OPT_OUT"
    },
    text_optimizations: {
      enroll_status: firestoreSettings.text ? "OPT_IN" : "OPT_OUT"
    },
    image_touchups: {
      enroll_status: firestoreSettings.visual ? "OPT_IN" : "OPT_OUT"
    },
    video_auto_crop: {
      enroll_status: firestoreSettings.visual ? "OPT_IN" : "OPT_OUT"
    }
  }
}



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
  const redirectUri = `https://www.facebook.com/v21.0/dialog/oauth?client_id=2343862285947895&redirect_uri=https://meta-ad-uploader-server-production.up.railway.app/auth/callback&scope=ads_read,ads_management,business_management,pages_show_list,email,pages_read_engagement,instagram_basic&response_type=code`;
  res.redirect(redirectUri);
});


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
        fields: 'id,name,email,picture'
      }
    });

    const { id: facebookId, name, email, picture } = meResponse.data;

    req.session.user = {
      name,
      facebookId, // ✅ this is critical
      email,
      profilePicUrl: picture?.data?.url || ""
    };


    // ✅ 4. Firestore Integration — add or update user
    await createOrUpdateUser({
      facebookId,
      name,
      email,
      picture,
      accessToken: longLivedToken
    })


    // 5. Final redirect
    res.redirect('https://batchadupload.vercel.app/?loggedIn=true');

  } catch (error) {
    console.error('OAuth Callback Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to complete Facebook Login' });
  }
});


app.get("/auth/me", async (req, res) => {
  const sessionUser = req.session.user
  if (!sessionUser) {
    return res.status(401).json({ error: "Not authenticated" })
  }

  try {
    const userData = await getUserByFacebookId(sessionUser.facebookId)

    if (!userData) {
      return res.status(401).json({ error: "User not found in database" })
    }

    return res.json({
      user: {
        name: userData.name,
        email: userData.email,
        preferences: userData.preferences || {},
        hasCompletedSignup: userData.hasCompletedSignup,
        profilePicUrl: userData.picture?.data?.url || "",
      },
    })
  } catch (err) {
    console.error("Error in /auth/me:", err)
    return res.status(500).json({ error: "Internal server error" })
  }
})



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
        fields: 'id,name,status,insights.date_preset(last_7d){spend}',


      }
    });


    const campaigns = campaignsResponse.data.data.map(camp => {
      const spend = parseFloat(camp.insights?.data?.[0]?.spend || "0");
      return { ...camp, spend };
    });


    res.json({ campaigns });
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

    // 🔄 Fetch profile pictures using /{pageId}/picture?redirect=false
    const pagesWithPictures = await Promise.all(
      pages.map(async (page) => {
        let profilePicture = null
        let instagramAccount = null

        try {
          // ✅ 1. Fetch Page Profile Picture
          const picRes = await axios.get(`https://graph.facebook.com/v21.0/${page.id}/picture`, {
            params: {
              access_token: page.access_token,
              redirect: false,
            },
          })
          profilePicture = picRes.data?.data?.url || "https://meta-ad-uploader-server-production.up.railway.app/backup_page_image.png"
        } catch (err) {
          console.warn(`Failed to fetch profile picture for page ${page.id}:`, err.message)
        }

        try {
          // ✅ 2. Fetch Connected Instagram Business Account
          const igRes = await axios.get(`https://graph.facebook.com/v22.0/${page.id}`, {
            params: {
              access_token: page.access_token,
              fields: "instagram_business_account"
            },
          })

          const igAccountId = igRes.data?.instagram_business_account?.id;

          if (igAccountId) {
            // ✅ 3. Optionally fetch IG account details (username, profile pic)
            try {
              const igDetailsRes = await axios.get(`https://graph.facebook.com/v22.0/${igAccountId}`, {
                params: {
                  access_token: page.access_token,
                  fields: 'username,profile_picture_url',
                },
              })


              instagramAccount = {
                id: igAccountId,
                username: igDetailsRes.data?.username || null,
                profilePictureUrl: igDetailsRes.data?.profile_picture_url || null,
              }

            } catch (err) {
              console.error(` Failed to fetch IG details for IG ID ${igAccountId} (page ${page.id}):`)

              if (err.response) {
                // The API responded with an error (not 2xx)
                console.error("Response status:", err.response.status)
                console.error("Response data:", err.response.data)
              } else if (err.request) {
                // No response was received
                console.error("No response received:", err.request)
              } else {
                // Something else happened setting up the request
                console.error("Error message:", err.message)
              }
            }


          }
          else {


          }
        } catch (err) {
          console.error(`Failed to fetch IG account for page ${page.id}:`, err.message)
        }

        return {
          ...page,
          profilePicture,
          instagramAccount, // ✅ sent to frontend
        }
      })
    )


    res.json({ success: true, pages: pagesWithPictures });

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


//url tag builder
function buildUrlTagsFromPairs(utmPairs) {
  return utmPairs
    .filter(p => p.key && p.value)
    .map(p => `${p.key}=${p.value}`)
    .join("&");
}

//helper functions
function cleanupUploadedFiles(files) {
  if (!files) return;
  Object.values(files).flat().forEach(file => {
    fs.unlink(file.path, err => {
      if (err) console.error("Failed to clean up file:", file.path, err.message);
    });
  });
}

// Helper: Build video creative payload
function buildVideoCreativePayload({ adName, adSetId, pageId, videoId, cta, link, headlines, messagesArray, descriptionsArray, thumbnailHash, thumbnailUrl, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements }) {
  if (useDynamicCreative) {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: {
          page_id: pageId,
          ...(instagramAccountId && { instagram_user_id: instagramAccountId }),
        },
        ...(urlTags && { url_tags: urlTags }),
        asset_feed_spec: {
          videos: [{
            video_id: videoId,
            ...(thumbnailHash
              ? { thumbnail_hash: thumbnailHash }
              : { image_url: thumbnailUrl }
            )
          }],
          titles: headlines.map(text => ({ text })),
          bodies: messagesArray.map(text => ({ text })),
          descriptions: descriptionsArray.map(text => ({ text })),
          ad_formats: ["SINGLE_VIDEO"],
          call_to_action_types: [cta],
          link_urls: [{ website_url: link }]
        },
        degrees_of_freedom_spec: {
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

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
          ...(instagramAccountId && { instagram_user_id: instagramAccountId }),
          video_data: {
            video_id: videoId,
            call_to_action: { type: cta, value: { link } },
            message: messagesArray[0],
            title: headlines[0],
            link_description: descriptionsArray[0],
            ...(thumbnailHash
              ? { image_hash: thumbnailHash }
              : { image_url: thumbnailUrl }
            )
          }
        },
        ...(urlTags && { url_tags: urlTags }),
        degrees_of_freedom_spec: {
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

        }
      },
      status: 'ACTIVE'
    };
  }
}

// Helper: Build image creative payload
function buildImageCreativePayload({ adName, adSetId, pageId, imageHash, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements }) {
  if (useDynamicCreative) {
    return {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: {
          page_id: pageId,
          ...(instagramAccountId && { instagram_user_id: instagramAccountId })
        },
        ...(urlTags && { url_tags: urlTags }),
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
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

        }
      },
      status: 'ACTIVE'
    };
  } else {
    const finalPayload = {
      name: adName,
      adset_id: adSetId,
      creative: {
        object_story_spec: {
          page_id: pageId,
          ...(instagramAccountId && { instagram_user_id: instagramAccountId }),
          link_data: {
            name: headlines[0],
            description: descriptionsArray[0],
            call_to_action: { type: cta, value: { link } },
            message: messagesArray[0],
            link: link,
            caption: link,
            image_hash: imageHash,
          },
        },
        ...(urlTags && { url_tags: urlTags }),
        degrees_of_freedom_spec: {
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

        },
      },
      status: "ACTIVE",
    };
    return finalPayload;

  }
}



async function handleVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements) {
  const file = req.files.imageFile?.[0];
  if (!file) throw new Error('Video file is required');

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

  if (useDynamicCreative) {
    await waitForVideoProcessing(videoId, token);
  }

  // Handle thumbnail
  const thumbnailFile = req.files.thumbnail?.[0];


  let thumbnailHash = null;
  let thumbnailUrl = null;

  if (thumbnailFile) {
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
    const key = Object.keys(imagesInfo)[0];
    thumbnailHash = imagesInfo[key].hash;

    await fs.promises.unlink(thumbnailFile.path).catch(err => console.error("Error deleting thumbnail file:", err));
  }

  else {
    thumbnailUrl = "https://meta-ad-uploader-server-production.up.railway.app/thumbnail.jpg";
  }

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
    thumbnailUrl,
    useDynamicCreative,
    instagramAccountId,
    urlTags,
    creativeEnhancements
  });

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, {
    params: { access_token: token }
  });

  await fs.promises.unlink(file.path).catch(err => console.error("Error deleting video file:", err));
  return createAdResponse.data;
}



// Helper: Handle Image Ad Creation
async function handleImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements) {
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
    useDynamicCreative,
    instagramAccountId,
    urlTags,
    creativeEnhancements
  });
  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;

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
      const { adName, adSetId, pageId, link, cta, adAccountId, instagramAccountId } = req.body;

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

      const adAccountSettings = await getAdAccountSettings(req.session.user.facebookId, adAccountId);

      const creativeEnhancements = adAccountSettings?.creativeEnhancements || {};
      const utmPairs = adAccountSettings?.defaultUTMs || [];
      const urlTags = buildUrlTagsFromPairs(utmPairs);



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
            descriptionsArray,
            instagramAccountId,
            urlTags,
            creativeEnhancements
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
            descriptionsArray,
            instagramAccountId,
            urlTags,
            creativeEnhancements
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
            useDynamicCreative,
            instagramAccountId,
            urlTags,
            creativeEnhancements
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
            useDynamicCreative,
            instagramAccountId,
            urlTags,
            creativeEnhancements
          );
        }
      }
      return res.json(result);
    } catch (error) {
      console.error('Create Ad Error:', error.response?.data || error.message);
      cleanupUploadedFiles(req.files); // 🧼 cleanup
      const fbErrorMsg = error.response?.data?.error?.error_user_msg || error.message || 'Failed to create ad';
      return res.status(400).send(fbErrorMsg);
    }
  }
);


//fireBase routes
app.post("/settings/save", async (req, res) => {
  const sessionUser = req.session.user;
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });

  const { facebookId } = sessionUser;
  const { globalSettings, adAccountSettings, adAccountId } = req.body;

  try {
    if (globalSettings) {
      await saveGlobalSettings(facebookId, globalSettings);
    }
    if (adAccountSettings && adAccountId) {
      await saveAdAccountSettings(facebookId, adAccountId, adAccountSettings);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Settings save error:", err);
    return res.status(500).json({ error: "Failed to save settings" });
  }
});

app.post("/settings/delete-template", async (req, res) => {
  const sessionUser = req.session.user;
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });

  const { adAccountId, templateName } = req.body;

  if (!adAccountId || !templateName) {
    return res.status(400).json({ error: "Missing adAccountId or templateName" });
  }

  try {
    await deleteCopyTemplate(sessionUser.facebookId, adAccountId, templateName);
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete template error:", err);
    return res.status(500).json({ error: "Failed to delete template" });
  }
});


app.post("/auth/manual-login", async (req, res) => {
  const { username, password } = req.body;
  if (username !== STATIC_LOGIN.username || password !== STATIC_LOGIN.password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  try {
    // Retrieve your Facebook-linked user
    const facebookId = "10236978990363167"; // replace with the actual Facebook ID in Firestore
    const userData = await getUserByFacebookId(facebookId);

    if (!userData) return res.status(404).json({ error: "User not found" });

    req.session.user = {
      name: userData.name,
      email: userData.email,
      facebookId,
      profilePicUrl: userData.picture?.data?.url || "",
    };
    req.session.accessToken = userData.accessToken;

    return res.json({ success: true });
  } catch (err) {
    console.error("Manual login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


app.get("/settings/global", async (req, res) => {
  const sessionUser = req.session.user;
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });

  try {
    const settings = await getGlobalSettings(sessionUser.facebookId);
    res.json({ settings });
  } catch (err) {
    console.error("Global settings fetch error:", err);
    res.status(500).json({ error: "Failed to fetch global settings" });
  }
});

app.get("/settings/ad-account", async (req, res) => {
  const sessionUser = req.session.user;
  const { adAccountId } = req.query;
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });
  if (!adAccountId) return res.status(400).json({ error: "Missing adAccountId" });

  try {
    const settings = await getAdAccountSettings(sessionUser.facebookId, adAccountId);
    res.json({ settings });
  } catch (err) {
    console.error("Ad account settings fetch error:", err);
    res.status(500).json({ error: "Failed to fetch ad account settings" });
  }
});


// Helper: Process multiple images for dynamic creative.
async function handleDynamicImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, instagramAccountId, urlTags, creativeEnhancements) {
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
      object_story_spec: {
        page_id: pageId,
        ...(instagramAccountId && { instagram_user_id: instagramAccountId })
      },
      ...(urlTags && { url_tags: urlTags }),
      asset_feed_spec: assetFeedSpec,
      degrees_of_freedom_spec: {
        creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

      }
    },
    status: 'ACTIVE'
  };

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, { params: { access_token: token } });
  return createAdResponse.data;
}


async function handleDynamicVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, instagramAccountId, urlTags, creativeEnhancements) {
  const mediaFiles = req.files.mediaFiles;
  const thumbFile = req.files.thumbnail?.[0];
  const fallbackThumbnailUrl = "https://meta-ad-uploader-server-production.up.railway.app/thumbnail.jpg";

  const videoAssets = [];

  for (let i = 0; i < mediaFiles.length; i++) {
    const file = mediaFiles[i];

    // Upload video
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

    let thumbnailSource = {};

    if (thumbFile) {
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
      thumbnailSource = { thumbnail_hash: imagesInfo[key].hash };
    }


    else {
      thumbnailSource = { thumbnail_url: fallbackThumbnailUrl };
    }

    videoAssets.push({
      video_id: videoId,
      ...thumbnailSource
    });

    await fs.promises.unlink(file.path).catch(err => console.error("Error deleting video file:", err));
  }

  if (thumbFile) {
    await fs.promises.unlink(thumbFile.path).catch(err => console.error("Error deleting thumbnail file:", err));
  }

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
      object_story_spec: {
        page_id: pageId,
        ...(instagramAccountId && { instagram_user_id: instagramAccountId })
      },
      ...(urlTags && { url_tags: urlTags }),
      asset_feed_spec: assetFeedSpec,
      degrees_of_freedom_spec: {
        creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

      }
    },
    status: 'ACTIVE'
  };

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, { params: { access_token: token } });
  return createAdResponse.data;
}



// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });

process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  try {
    await redisClient.quit();
    console.log('Redis client disconnected');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});
