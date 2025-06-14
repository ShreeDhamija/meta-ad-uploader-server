const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
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
const crypto = require('crypto');
const { google } = require('googleapis');

app.use(cors({
  origin: [
    'https://www.withblip.com'
  ],
  credentials: true
}));



app.options("*", cors({
  origin: 'https://www.withblip.com',
  credentials: true
}));

app.use(express.json());
app.set('trust proxy', 1);
app.use(express.static('public'));


const STATIC_LOGIN = {
  username: "metatest",
  password: "password", // ideally use env variable
};

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('ready', () => {
  console.log('✅ Redis client is ready');
});

redisClient.connect();
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'none'
  }
}));


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

async function retryWithBackoff(fn, maxAttempts = 3, initialDelay = 1000) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      const fbErr = err.response?.data?.error;
      const isTransient = fbErr?.is_transient || fbErr?.code === 2;

      if (!isTransient || attempt === maxAttempts - 1) {
        throw err;
      }

      const delay = initialDelay * Math.pow(2, attempt); // exponential backoff
      console.warn(`⚠️ Transient error (attempt ${attempt + 1}), retrying in ${delay}ms`);
      await new Promise((res) => setTimeout(res, delay));
      attempt++;
    }
  }
}

//google auth initialization
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://meta-ad-uploader-server-production.up.railway.app/auth/google/callback' // Your redirect URI
);
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];



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
  const clientId = process.env.META_APP_ID; // add this to your .env file
  const redirectUri = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${clientId}&redirect_uri=https://meta-ad-uploader-server-production.up.railway.app/auth/callback&scope=ads_read,ads_management,business_management,pages_show_list,email,pages_read_engagement,instagram_basic,pages_manage_ads&auth_type=rerequest&response_type=code`;
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
    //console.log("✅ Long-lived token received");
    console.log("🔑 New long-lived token from Facebook login:", longLivedToken);


    // 3. Store token in session
    req.session.accessToken = longLivedToken;

    const meResponse = await axios.get('https://graph.facebook.com/v21.0/me', {
      params: {
        access_token: longLivedToken,
        fields: 'id,name,email,picture'
      }
    });

    const { id: facebookId, name, email, picture } = meResponse.data;

    req.session.user = {
      name,
      facebookId,
      email,
      profilePicUrl: picture?.data?.url || ""
    };

    //console.log("📦 Session about to be saved:", req.session);

    // 4. Save session before redirect
    req.session.save(async (err) => {
      if (err) {
        console.error("❌ Session save failed:", err);
        return res.status(500).send("Session save error");
      }

      //      console.log("✅ Session saved successfully");

      // 5. Update Firestore
      await createOrUpdateUser({
        facebookId,
        name,
        email,
        //picture,
        accessToken: longLivedToken
      });

      // 6. Redirect
      res.redirect('https://www.withblip.com/?loggedIn=true');
    });

  } catch (error) {
    console.error('OAuth Callback Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to complete Facebook Login' });
  }
});

app.get("/auth/me", async (req, res) => {
  const sessionUser = req.session.user;
  const accessToken = req.session.accessToken;

  if (!sessionUser || !accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const userData = await getUserByFacebookId(sessionUser.facebookId);

    if (!userData) {
      return res.status(401).json({ error: "User not found in database" });
    }

    // Get latest profile picture using the stored access token
    const picResponse = await axios.get(`https://graph.facebook.com/${sessionUser.facebookId}/picture`, {
      params: {
        access_token: accessToken,
        type: "normal",
        redirect: false
      }
    });

    const profilePicUrl = picResponse.data?.data?.url || "";

    return res.json({
      user: {
        name: userData.name,
        email: userData.email,
        preferences: userData.preferences || {},
        hasCompletedSignup: userData.hasCompletedSignup,
        profilePicUrl,
      }
    });
  } catch (err) {
    console.error("Error in /auth/me:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});




app.get('/auth/fetch-ad-accounts', async (req, res) => {
  const token = req.session.accessToken;
  console.log("Session token used to fetch ad accounts:", req.session.accessToken);
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
        fields: 'id,name,status,insights.date_preset(last_7d){spend},smart_promotion_type',

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
        fields: 'id,name,status,is_dynamic_creative,effective_status,insights.date_preset(last_7d){spend},destination_type'
      }
    });
    const adSets = adSetsResponse.data.data.map(adset => {
      const spend = parseFloat(adset.insights?.data?.[0]?.spend || "0");
      return { ...adset, spend };
    });
    res.json({ adSets });

  } catch (error) {
    console.error('Fetch Ad Sets Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch ad sets' });
  }
});


app.post('/auth/duplicate-adset', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });

  const { adSetId, campaignId, adAccountId, newAdSetName } = req.body; // Add newAdSetName
  if (!adSetId || !campaignId || !adAccountId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // Step 1: Duplicate the ad set
    const copyUrl = `https://graph.facebook.com/v21.0/${adSetId}/copies`;
    const params = {
      campaign_id: campaignId,
      rename_options: JSON.stringify({ rename_suffix: '_02' }),
      access_token: token,
      status_option: "ACTIVE",

    };
    const copyResponse = await axios.post(copyUrl, null, { params });
    const newAdSetId = copyResponse.data.copied_adset_id;

    // Step 2: Update the ad set name if newAdSetName is provided
    if (newAdSetName && newAdSetName.trim() !== '') {
      const updateUrl = `https://graph.facebook.com/v21.0/${newAdSetId}`;
      const updateParams = {
        name: newAdSetName.trim(),
        access_token: token,
      };

      try {
        await axios.post(updateUrl, null, { params: updateParams });
        console.log(`Ad set ${newAdSetId} renamed to: ${newAdSetName.trim()}`);
      } catch (updateError) {
        console.error('Failed to update ad set name:', updateError.response?.data || updateError.message);
        // Don't fail the entire request if renaming fails, just log the error
        // The ad set was still created successfully
      }
    }

    return res.json({ copied_adset_id: newAdSetId });
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



app.get('/auth/fetch-shop-data', async (req, res) => {
  const token = req.session.accessToken;
  const { pageId } = req.query;
  console.log("selected page", pageId);

  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  if (!pageId) return res.status(400).json({ error: 'Missing pageId' });

  try {
    // Step 1: Fetch user's pages to get page access token
    const pagesResponse = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token: token,
        fields: 'id,name,access_token'
      }
    });

    const pages = pagesResponse.data.data;
    const page = pages.find(p => p.id === pageId);
    if (!page) return res.status(404).json({ error: 'Page not found in user accounts' });

    const pageAccessToken = page.access_token;

    // Step 2: Fetch shops info
    const shopsUrl = `https://graph.facebook.com/v21.0/${pageId}/commerce_merchant_settings`;
    const shopsResponse = await axios.get(shopsUrl, {
      params: {
        fields: 'id,shops{id,fb_sales_channel{status,fb_page{id,name}},is_onsite_enabled,shop_status}',
        access_token: pageAccessToken
      }
    });

    // Parse the merchant settings array
    const merchantSettings = shopsResponse.data.data || [];
    if (merchantSettings.length === 0) {
      console.log("No merchant settings found");
      return res.json({
        shops: [],
        product_sets: [],
        products: []
      });
    }

    // Get shops from the first merchant setting
    const shopsData = merchantSettings[0]?.shops?.data || [];
    console.log("Shops Data", shopsData);

    const shops = shopsData.map(shop => ({
      storefront_shop_id: shop.id,
      fb_page_id: shop.fb_sales_channel?.fb_page?.id || null,
      fb_page_name: shop.fb_sales_channel?.fb_page?.name || `Shop ${shop.id}`,
      is_onsite_enabled: shop.is_onsite_enabled || false,
      shop_status: shop.shop_status || 'UNKNOWN',
      fb_sales_channel_status: shop.fb_sales_channel?.status || 'UNKNOWN'
    }));

    // Step 3: Fetch product sets and products
    const productsResponse = await axios.get(shopsUrl, {
      params: {
        fields: 'id,product_catalogs{id,product_sets{id,name},products{id,name}}',
        access_token: pageAccessToken
      }
    });

    // Parse product catalogs the same way
    const merchantSettingsForProducts = productsResponse.data.data || [];
    const productCatalogs = merchantSettingsForProducts[0]?.product_catalogs?.data || [];
    console.log("productCatalogs", productCatalogs);

    const productSets = [];
    const products = [];

    for (const catalog of productCatalogs) {
      const sets = catalog.product_sets?.data || [];
      const prods = catalog.products?.data || [];

      productSets.push(...sets.map(set => ({ id: set.id, name: set.name })));
      products.push(...prods.map(prod => ({ id: prod.id, name: prod.name })));
    }

    console.log("Shops", shops);
    console.log("product sets", productSets);
    console.log("products", products);

    return res.json({
      shops,
      product_sets: productSets,
      products
    });

  } catch (error) {
    console.error('Fetch shop data error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to fetch shop data' });
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
function buildVideoCreativePayload({ adName, adSetId, pageId, videoId, cta, link, headlines, messagesArray, descriptionsArray, thumbnailHash, thumbnailUrl, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus }) {

  let shopDestinationFieldsForAssetFeed = {};

  if (shopDestination && shopDestinationType) {
    const onsiteDestinationObject = {};
    if (shopDestinationType === "shop") {
      onsiteDestinationObject.storefront_shop_id = shopDestination;
    } else if (shopDestinationType === "product_set") {
      onsiteDestinationObject.shop_collection_product_set_id = shopDestination;
    } else if (shopDestinationType === "product") {
      onsiteDestinationObject.details_page_product_id = shopDestination;
    }
    shopDestinationFieldsForAssetFeed.onsite_destinations = [onsiteDestinationObject];
    shopDestinationFieldsForAssetFeed.ad_formats = ["CAROUSEL"];
  }

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
          link_urls: [{ website_url: link }],
          ...shopDestinationFieldsForAssetFeed, // Apply shop destination fields

        },
        degrees_of_freedom_spec: {
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

        }
      },
      status: adStatus
    };
  } else { // Non-Dynamic
    const creativePart = {
      object_story_spec: {
        page_id: pageId,
        ...(instagramAccountId && { instagram_user_id: instagramAccountId }),
        video_data: {
          video_id: videoId,
          call_to_action: { type: cta, value: { link } },
          message: messagesArray[0],
          title: headlines[0],
          link_description: descriptionsArray[0],
          ...(thumbnailHash ? { image_hash: thumbnailHash } : { image_url: thumbnailUrl })
        }
      },
      ...(urlTags && { url_tags: urlTags }),
      degrees_of_freedom_spec: {
        creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)
      }
    };

    if (Object.keys(shopDestinationFieldsForAssetFeed).length > 0) {
      creativePart.asset_feed_spec = shopDestinationFieldsForAssetFeed;
    }

    return {
      name: adName,
      adset_id: adSetId,
      creative: creativePart,
      status: adStatus
    };
  }

}

// Helper: Build image creative payload
function buildImageCreativePayload({ adName, adSetId, pageId, imageHash, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus }) {

  let shopDestinationFieldsForAssetFeed = {};

  if (shopDestination && shopDestinationType) {
    const onsiteDestinationObject = {};
    if (shopDestinationType === "shop") {
      onsiteDestinationObject.storefront_shop_id = shopDestination;
    } else if (shopDestinationType === "product_set") {
      onsiteDestinationObject.shop_collection_product_set_id = shopDestination;
    } else if (shopDestinationType === "product") {
      onsiteDestinationObject.details_page_product_id = shopDestination;
    }
    shopDestinationFieldsForAssetFeed.onsite_destinations = [onsiteDestinationObject];
    shopDestinationFieldsForAssetFeed.ad_formats = ["CAROUSEL"];
  }

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
          link_urls: [{ website_url: link }],
          ...shopDestinationFieldsForAssetFeed,

        },
        degrees_of_freedom_spec: {
          creative_features_spec: buildCreativeEnhancementsConfig(creativeEnhancements)

        }
      },
      status: adStatus
    };
  } else { // Non-Dynamic
    const creativePart = {
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
    };

    if (Object.keys(shopDestinationFieldsForAssetFeed).length > 0) {
      creativePart.asset_feed_spec = shopDestinationFieldsForAssetFeed;
    }

    return {
      name: adName,
      adset_id: adSetId,
      creative: creativePart,
      status: adStatus
    };
  }

}



async function handleVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus) {
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
    creativeEnhancements,
    shopDestination,
    shopDestinationType,
    adStatus
  });

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await retryWithBackoff(() =>
    axios.post(createAdUrl, creativePayload, {
      params: { access_token: token }
    })
  );


  await fs.promises.unlink(file.path).catch(err => console.error("Error deleting video file:", err));
  return createAdResponse.data;
}



// Helper: Handle Image Ad Creation
async function handleImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, useDynamicCreative, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus) {
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
    creativeEnhancements,
    shopDestination,
    shopDestinationType,
    adStatus
  });
  console.log(creativePayload);
  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await retryWithBackoff(() =>
    axios.post(createAdUrl, creativePayload, {
      params: { access_token: token }
    })
  );


  fs.unlink(file.path, err => {
    if (err) console.error("Error deleting image file:", err);
    else console.log("Image file deleted:", file.path);
  });

  return createAdResponse.data;
}



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
      const { adName, adSetId, pageId, link, cta, adAccountId, instagramAccountId, shopDestination, shopDestinationType, launchPaused } = req.body;

      if (!adAccountId) return res.status(400).json({ error: 'Missing adAccountId' });

      const parseField = (field, fallback) => {
        try { return JSON.parse(field); } catch (e) { return fallback ? [fallback] : []; }
      };
      const headlines = parseField(req.body.headlines, req.body.headline);
      const descriptionsArray = parseField(req.body.descriptions, req.body.description);
      const messagesArray = parseField(req.body.messages, req.body.message);
      const adStatus = launchPaused === 'true' ? 'PAUSED' : 'ACTIVE';


      // Parse drive files if they exist (for dynamic ad sets)
      const driveFiles = [];
      if (req.body.driveFiles) {
        // Handle multiple drive files for dynamic creative
        if (Array.isArray(req.body.driveFiles)) {
          for (const fileJson of req.body.driveFiles) {
            try {
              driveFiles.push(JSON.parse(fileJson));
            } catch (e) {
              console.error("Error parsing drive file JSON:", e);
            }
          }
        } else {
          // Handle single drive file JSON string
          try {
            driveFiles.push(JSON.parse(req.body.driveFiles));
          } catch (e) {
            console.error("Error parsing drive file JSON:", e);
          }
        }
      }

      // Fetch the ad set info to determine dynamic creative.
      const adSetInfoUrl = `https://graph.facebook.com/v21.0/${adSetId}`;
      const adSetInfoResponse = await axios.get(adSetInfoUrl, {
        params: { access_token: token, fields: 'is_dynamic_creative' }
      });
      const adSetDynamicCreative = adSetInfoResponse.data.is_dynamic_creative;
      const useDynamicCreative = adSetDynamicCreative;

      const adAccountSettings = await getAdAccountSettings(req.session.user.facebookId, adAccountId);
      const creativeEnhancements = adAccountSettings?.creativeEnhancements || {};
      const utmPairs = adAccountSettings?.defaultUTMs || [];
      const urlTags = buildUrlTagsFromPairs(utmPairs);

      // Handle Google Drive files for DYNAMIC ad sets only
      if (useDynamicCreative && driveFiles.length > 0) {
        req.files = req.files || {};
        req.files.mediaFiles = req.files.mediaFiles || [];

        for (const driveFile of driveFiles) {
          try {
            console.log(`Processing drive file for dynamic ad set: ${driveFile.name}`);

            const fileRes = await axios({
              url: `https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`,
              method: 'GET',
              responseType: 'stream',
              headers: { Authorization: `Bearer ${driveFile.accessToken}` },
            });

            const tempDir = path.resolve(__dirname, 'tmp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

            const extension = driveFile.mimeType.startsWith('video/') ? '.mp4' : '.jpg';
            const tempPath = path.join(tempDir, `${uuidv4()}-${driveFile.name}${extension}`);

            const writer = fs.createWriteStream(tempPath);
            fileRes.data.pipe(writer);
            await new Promise((resolve) => writer.on('finish', resolve));

            const fakeFile = {
              path: tempPath,
              mimetype: driveFile.mimeType,
              originalname: driveFile.name,
              filename: path.basename(tempPath),
            };

            req.files.mediaFiles.push(fakeFile);
            console.log(`Added drive file to mediaFiles for dynamic ad set: ${driveFile.name}`);
          } catch (error) {
            console.error(`Error processing drive file ${driveFile.name}:`, error);
          }
        }
      }

      // Handle single Google Drive file for REGULAR ad sets (preserve original logic)
      if (!useDynamicCreative && req.body.driveFile === 'true' && req.body.driveId && req.body.driveAccessToken) {
        try {
          console.log(`Processing single drive file for regular ad set: ${req.body.driveName}`);

          const fileRes = await axios({
            url: `https://www.googleapis.com/drive/v3/files/${req.body.driveId}?alt=media`,
            method: 'GET',
            responseType: 'stream',
            headers: { Authorization: `Bearer ${req.body.driveAccessToken}` },
          });

          const tempDir = path.resolve(__dirname, 'tmp');
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

          const extension = req.body.driveMimeType.startsWith('video/') ? '.mp4' : '.jpg';
          const tempPath = path.join(tempDir, `${uuidv4()}-${req.body.driveName}${extension}`);

          const writer = fs.createWriteStream(tempPath);
          fileRes.data.pipe(writer);
          await new Promise((resolve) => writer.on('finish', resolve));

          const fakeFile = {
            path: tempPath,
            mimetype: req.body.driveMimeType,
            originalname: req.body.driveName,
            filename: path.basename(tempPath),
          };

          // Add to imageFile for regular ad sets
          req.files = req.files || {};
          req.files.imageFile = [fakeFile];
          console.log(`Added drive file to imageFile for regular ad set: ${req.body.driveName}`);
        } catch (error) {
          console.error(`Error processing drive file for regular ad set:`, error);
          return res.status(400).json({ error: 'Failed to process Google Drive file' });
        }
      }

      let result;
      // For dynamic ad creative, use the aggregated media fields.
      if (useDynamicCreative) {
        // Expect the aggregated files to be in req.files.mediaFiles
        const mediaFiles = req.files.mediaFiles;
        if (!mediaFiles || mediaFiles.length === 0) {
          return res.status(400).json({ error: 'No media files received for dynamic creative' });
        }

        console.log(`Processing ${mediaFiles.length} files for dynamic creative ad set`);

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
            creativeEnhancements,
            shopDestination,
            shopDestinationType,
            adStatus
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
            creativeEnhancements,
            shopDestination,
            shopDestinationType,
            adStatus
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
            creativeEnhancements,
            shopDestination,
            shopDestinationType,
            adStatus
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
            creativeEnhancements,
            shopDestination,
            shopDestinationType,
            adStatus
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

app.get('/auth/generate-ad-preview', async (req, res) => {
  const token = req.session.accessToken;
  if (!token) return res.status(401).json({ error: 'User not authenticated' });

  const { adAccountId } = req.query;
  if (!adAccountId) return res.status(400).json({ error: 'Missing adAccountId' });

  try {
    const recentAds = await fetchRecentAds(adAccountId, token);
    //console.log(`🆕 Found ${recentAds.length} recent ads created in last 5 minutes`);
    recentAds.forEach(ad => {
      //console.log(`- Ad ID: ${ad.id}, Creative ID: ${ad.creative?.id || 'No creative'}`);
    });


    if (!recentAds.length) {
      return res.status(404).json({ error: "No recent ads found" });
    }

    const previews = [];

    for (const ad of recentAds) {
      if (!ad.creative?.id) {
        console.warn(`Ad ${ad.id} has no creative linked, skipping.`);
        continue;
      }

      try {
        const previewUrl = `https://graph.facebook.com/v22.0/${ad.creative.id}/previews`;
        //console.log(`📡 Making internal call to: ${previewUrl} with adAccountId=${adAccountId}`);
        const previewResponse = await axios.get(previewUrl, {
          params: {
            access_token: token,
            ad_format: 'MOBILE_FEED_STANDARD'
          }
        });

        const previewData = previewResponse.data.data?.[0];
        // console.log(`✅ Successfully fetched preview for Ad ID: ${ad.id}`);
        if (previewData) {
          // 🖼 Extract preview URL from previewData
          const match = previewData.body.match(/src="([^"]+)"/);
          if (match && match[1]) {
            const rawUrl = match[1];
            const cleanUrl = rawUrl.replace(/&amp;/g, "&");
            console.log(`🌐 Preview URL: ${cleanUrl}`);
          } else {
            console.warn(`⚠️ Could not extract preview URL for Ad ID ${ad.id}`);
          }

          previews.push({
            adId: ad.id,
            creativeId: ad.creative.id,
            previewHtml: previewData.body, // iframe HTML
          });
        }

      } catch (previewError) {
        console.error(`Preview generation failed for creative ${ad.creative.id}:`, previewError.response?.data || previewError.message);
        // Continue to next ad even if this preview fails
      }
    }

    res.json({ previews });
  } catch (error) {
    console.error('Generate Preview Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate previews' });
  }
});

app.get("/auth/fetch-recent-copy", async (req, res) => {
  const token = req.session.accessToken;
  const { adAccountId } = req.query;

  if (!token) return res.status(401).json({ error: "Not authenticated" });
  if (!adAccountId) return res.status(400).json({ error: "Missing adAccountId" });

  try {
    const url = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
    const response = await axios.get(url, {
      params: {
        access_token: token,
        fields: 'name,creative{asset_feed_spec,title,body}',
        limit: 10,
        sort: 'created_time_desc',
      },
    });

    const formattedAds = (response.data.data || [])
      .map(ad => {
        const creative = ad.creative || {};
        const spec = creative.asset_feed_spec;

        // Fallback handling
        const primaryTexts = spec?.bodies?.map(b => b.text)
          || (creative.body ? [creative.body] : []);

        const headlines = spec?.titles?.map(t => t.text)
          || (creative.title ? [creative.title] : []);

        if (!primaryTexts.length && !headlines.length) return null; // still empty? skip

        return {
          adName: ad.name,
          primaryTexts,
          headlines,
        };
      })
      .filter(Boolean);


    res.json({ ads: formattedAds });
  } catch (err) {
    console.error("Fetch recent copy error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch recent ad copy" });
  }
});

app.get("/auth/fetch-recent-url-tags", async (req, res) => {
  const token = req.session.accessToken;
  const { adAccountId } = req.query;

  if (!token) return res.status(401).json({ error: "Not authenticated" });
  if (!adAccountId) return res.status(400).json({ error: "Missing adAccountId" });

  try {
    const adsRes = await axios.get(`https://graph.facebook.com/v22.0/${adAccountId}/ads`, {
      params: {
        access_token: token,
        fields: "creative",
        limit: 1,
        sort: "created_time_desc"
      }
    });

    const creativeId = adsRes.data?.data?.[0]?.creative?.id;
    if (!creativeId) return res.status(404).json({ error: "No recent creative found" });

    const creativeRes = await axios.get(`https://graph.facebook.com/v22.0/${creativeId}`, {
      params: {
        access_token: token,
        fields: "url_tags"
      }
    });

    const urlTags = creativeRes.data?.url_tags;
    if (!urlTags) return res.status(404).json({ error: "No URL tags found on latest ad" });

    // Parse the string into key-value pairs
    const pairs = urlTags.split("&").map((pair) => {
      const [key, value] = pair.split("=");
      return { key, value };
    });

    res.json({ pairs });
  } catch (err) {
    console.error("Fetch recent url_tags error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch url tags" });
  }
});





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

app.post('/meta-data-deletion', express.urlencoded({ extended: true }), (req, res) => {
  const signedRequest = req.body.signed_request;
  if (!signedRequest) {
    return res.status(400).json({ error: 'Missing signed_request' });
  }

  const [encodedSig, encodedPayload] = signedRequest.split('.');
  const sig = Buffer.from(encodedSig, 'base64');
  const payload = Buffer.from(encodedPayload, 'base64').toString();
  const data = JSON.parse(payload);

  const expectedSig = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(encodedPayload)
    .digest();

  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const confirmationCode = crypto.randomUUID();

  // Optionally delete the user's data from Firestore:
  // await deleteUserData(data.user_id)

  return res.json({
    url: "https://withblip.com",
    confirmation_code: confirmationCode
  });
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
    const accessToken = req.session.accessToken;

    // ✅ Fresh fetch for FB Page picture
    if (settings?.defaultPage?.id) {
      try {
        const picRes = await axios.get(`https://graph.facebook.com/v21.0/${settings.defaultPage.id}/picture`, {
          params: {
            access_token: accessToken,
            redirect: false,
          },
        });
        settings.defaultPage.profilePicture = picRes.data?.data?.url || null;
      } catch (err) {
        console.warn("Failed to refresh FB page picture:", err.message);
      }
    }

    // ✅ Fresh fetch for IG profile picture
    if (settings?.defaultInstagram?.id) {
      try {
        const igRes = await axios.get(`https://graph.facebook.com/v22.0/${settings.defaultInstagram.id}`, {
          params: {
            access_token: accessToken,
            fields: 'username,profile_picture_url',
          },
        });
        settings.defaultInstagram.profilePictureUrl = igRes.data?.profile_picture_url || null;
      } catch (err) {
        console.warn("Failed to refresh IG profile picture:", err.message);
      }
    }

    res.json({ settings });
  } catch (err) {
    console.error("Ad account settings fetch error:", err);
    res.status(500).json({ error: "Failed to fetch ad account settings" });
  }
});




app.get('/auth/google', (req, res) => {
  const isPopup = req.query.popup === 'true';

  const csrfToken = crypto.randomUUID();
  req.session.googleCSRF = csrfToken;

  const stateObj = {
    csrf: csrfToken,
    mode: isPopup ? 'popup' : 'normal'
  };

  const encodedState = Buffer.from(JSON.stringify(stateObj)).toString('base64');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: encodedState
  });

  res.redirect(authUrl);
});



app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }

  // 🔐 Validate the state parameter (anti-CSRF + popup mode)
  let decodedState;
  try {
    decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
  } catch (err) {
    return res.status(400).send("Invalid state encoding");
  }

  const isPopup = decodedState.mode === 'popup';
  const isValidCSRF = decodedState.csrf === req.session.googleCSRF;
  if (!isValidCSRF) {
    return res.status(400).send("Invalid OAuth state");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const accessToken = tokens.access_token;

    req.session.googleAccessToken = accessToken;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    if (isPopup) {
      return res.send(`
        <html><body>
          <script>
            window.opener?.postMessage(
              { type: 'google-auth-success', accessToken: '${accessToken}' },
              'https://www.withblip.com'
            );
            window.close();
          </script>
        </body></html>
      `);
    } else {
      return res.redirect('https://www.withblip.com/?googleAuth=success');
    }
  } catch (err) {
    console.error("Google auth error:", err);
    return res.status(500).send("Authentication failed");
  }
});


// 3️⃣ Helper to ensure valid token
async function ensureValidGoogleToken(req) {
  if (!req.session.googleTokens) {
    throw new Error('No Google tokens found');
  }

  oauth2Client.setCredentials(req.session.googleTokens);

  try {
    const { token } = await oauth2Client.getAccessToken();
    return token;
  } catch (error) {
    throw new Error('Token refresh failed: ' + error.message);
  }
}

// 4️⃣ Endpoint to check if user is authenticated and get token
app.get('/auth/google/status', async (req, res) => {
  const accessToken = req.session.googleAccessToken;
  const refreshToken = req.session.googleRefreshToken;

  if (accessToken) {
    return res.json({ authenticated: true, accessToken });
  }

  if (refreshToken) {
    try {
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await oauth2Client.refreshAccessToken();
      req.session.googleAccessToken = credentials.access_token;
      await new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));

      return res.json({ authenticated: true, accessToken: credentials.access_token });
    } catch (err) {
      console.error("Failed to refresh access token:", err);
      return res.json({ authenticated: false });
    }
  }

  return res.json({ authenticated: false });
});


// 5️⃣ Example: List Google Drive files
app.get('/auth/google/list-files', async (req, res) => {
  try {
    const accessToken = await ensureValidGoogleToken(req);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.list({
      pageSize: 30,
      fields: 'files(id, name, mimeType, thumbnailLink)',
      orderBy: 'modifiedTime desc',
    });

    return res.json({ files: response.data.files });
  } catch (error) {
    console.error('Google Drive list files error:', error.message);
    return res.status(500).json({ error: 'Failed to list files' });
  }
});

// 6️⃣ Logout: clear session
app.get('/auth/google/logout', (req, res) => {
  if (req.session.googleTokens) {
    delete req.session.googleTokens;
    req.session.save(err => {
      if (err) {
        console.error('Error saving session after Google logout:', err);
      }
      res.json({ success: true });
    });
  } else {
    res.json({ success: true });
  }
});



//to fetch ad previews
async function fetchRecentAds(adAccountId, token) {
  const url = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;

  const fiveMinutesAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 5 minutes ago, in Unix seconds

  const response = await axios.get(url, {
    params: {
      access_token: token,
      fields: 'id,creative,created_time',
      limit: 10,
      filtering: JSON.stringify([
        {
          field: "created_time",
          operator: "GREATER_THAN",
          value: fiveMinutesAgo
        }
      ])
    }
  });

  return response.data.data || [];
}


// Helper: Process multiple images for dynamic creative.
async function handleDynamicImageAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus) {
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

  let shopDestinationFields = {}; // Will hold { onsite_destinations: [...] }
  if (shopDestination && shopDestinationType) {
    const onsiteDestinationObject = {};
    if (shopDestinationType === "shop") {
      onsiteDestinationObject.storefront_shop_id = shopDestination;
    } else if (shopDestinationType === "product_set") {
      onsiteDestinationObject.shop_collection_product_set_id = shopDestination;
    } else if (shopDestinationType === "product") {
      onsiteDestinationObject.details_page_product_id = shopDestination;
    }
    shopDestinationFields.onsite_destinations = [onsiteDestinationObject]; // Correct structure
  }



  const assetFeedSpec = {
    images: imageHashes,
    titles: headlines.map(text => ({ text })),
    bodies: messagesArray.map(text => ({ text })),
    descriptions: descriptionsArray.map(text => ({ text })),
    ad_formats: ["SINGLE_IMAGE"],
    call_to_action_types: [cta],
    link_urls: [{ website_url: link }],
    ...shopDestinationFields // Apply shop spec

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
    status: adStatus
  };

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await retryWithBackoff(() =>
    axios.post(createAdUrl, creativePayload, {
      params: { access_token: token }
    })
  );

  return createAdResponse.data;
}


async function handleDynamicVideoAd(req, token, adAccountId, adSetId, pageId, adName, cta, link, headlines, messagesArray, descriptionsArray, instagramAccountId, urlTags, creativeEnhancements, shopDestination, shopDestinationType, adStatus) {
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

  let shopDestinationFields = {}; // Will hold { onsite_destinations: [...] }
  if (shopDestination && shopDestinationType) {
    const onsiteDestinationObject = {};
    if (shopDestinationType === "shop") {
      onsiteDestinationObject.storefront_shop_id = shopDestination;
    } else if (shopDestinationType === "product_set") {
      onsiteDestinationObject.shop_collection_product_set_id = shopDestination;
    } else if (shopDestinationType === "product") {
      onsiteDestinationObject.details_page_product_id = shopDestination;
    }
    shopDestinationFields.onsite_destinations = [onsiteDestinationObject]; // Correct structure
  }


  const assetFeedSpec = {
    videos: videoAssets,
    titles: headlines.map(text => ({ text })),
    bodies: messagesArray.map(text => ({ text })),
    descriptions: descriptionsArray.map(text => ({ text })),
    ad_formats: ["SINGLE_VIDEO"],
    call_to_action_types: [cta],
    link_urls: [{ website_url: link }],
    ...shopDestinationFields // Apply shop spec

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
    status: adStatus
  };

  const createAdUrl = `https://graph.facebook.com/v22.0/${adAccountId}/ads`;
  const createAdResponse = await axios.post(createAdUrl, creativePayload, { params: { access_token: token } });
  return createAdResponse.data;
}



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

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