// const { db } = require("./firebase")
// const admin = require("firebase-admin");


// // Add or update user data
// async function createOrUpdateUser({ facebookId, name, email, picture, accessToken }) {
//     const userRef = db.collection("users").doc(facebookId)
//     const userDoc = await userRef.get()

//     if (!userDoc.exists) {
//         await userRef.set({
//             name,
//             picture,
//             email: email || null,
//             accessToken,
//             createdAt: new Date(),

//         })
//         console.log("New user added to Firestore:", facebookId)
//     } else {
//         await userRef.update({ accessToken })
//         console.log("User already existed, token updated:", facebookId)
//     }
// }

// // Get user data by Facebook ID
// async function getUserByFacebookId(facebookId) {
//     const userRef = db.collection("users").doc(facebookId)
//     const userDoc = await userRef.get()
//     return userDoc.exists ? userDoc.data() : null
// }

// // Global Settings (per user)
// async function saveGlobalSettings(facebookId, globalSettings) {
//     const globalRef = db.collection("users").doc(facebookId).collection("settings").doc("global");
//     await globalRef.set(globalSettings, { merge: true });
// }

// // Ad Account Settings (per user per ad account)
// async function saveAdAccountSettings(facebookId, adAccountId, adAccountSettings) {
//     const adAccountRef = db
//         .collection("users")
//         .doc(facebookId)
//         .collection("adAccounts")
//         .doc(adAccountId);

//     await adAccountRef.set(adAccountSettings, { merge: true });
// }

// async function getGlobalSettings(facebookId) {
//     const docRef = db.collection("users").doc(facebookId).collection("settings").doc("global");
//     const docSnap = await docRef.get();
//     return docSnap.exists ? docSnap.data() : null;
// }

// // Get ad account settings
// async function getAdAccountSettings(facebookId, adAccountId) {
//     const docRef = db.collection("users").doc(facebookId).collection("adAccounts").doc(adAccountId);
//     const docSnap = await docRef.get();
//     return docSnap.exists ? docSnap.data() : null;
// }

// // firebaseController.js

// async function deleteCopyTemplate(facebookId, adAccountId, templateName) {
//     const adAccountRef = db
//         .collection("users")
//         .doc(facebookId)
//         .collection("adAccounts")
//         .doc(adAccountId);

//     const adDoc = await adAccountRef.get();
//     const data = adDoc.data();

//     const isDefault = data?.defaultTemplateName === templateName;
//     const templates = data?.copyTemplates || {};

//     // Remove the template from local object
//     delete templates[templateName];

//     const updatePayload = {
//         [`copyTemplates.${templateName}`]: admin.firestore.FieldValue.delete()
//     };

//     // If it was default, and we still have other templates left
//     const remainingTemplateNames = Object.keys(templates);
//     if (isDefault) {
//         if (remainingTemplateNames.length > 0) {
//             updatePayload.defaultTemplateName = remainingTemplateNames[0]; // Set new default
//         } else {
//             updatePayload.defaultTemplateName = admin.firestore.FieldValue.delete(); // Clear it
//         }
//     }

//     await adAccountRef.update(updatePayload);

//     return true;
// }



// module.exports = {
//     createOrUpdateUser,
//     getUserByFacebookId,
//     saveGlobalSettings,
//     saveAdAccountSettings,
//     getGlobalSettings,
//     getAdAccountSettings,
//     deleteCopyTemplate,
// };


const { db } = require("./firebase")
const admin = require("firebase-admin");

// Add or update user data
async function createOrUpdateUser({ facebookId, name, email, picture, accessToken }) {
    const userRef = db.collection("users").doc(facebookId)
    const userDoc = await userRef.get()

    if (!userDoc.exists) {
        // Create user document
        await userRef.set({
            name,
            picture,
            email: email || null,
            accessToken,
            createdAt: new Date(),
        })

        // Create payment status document
        const trialEndDate = new Date();
        trialEndDate.setDate(trialEndDate.getDate() + 7); // 14-day trial

        const paymentRef = db.collection("users").doc(facebookId).collection("paymentStatus").doc("subscription");
        await paymentRef.set({
            subscriptionStatus: 'trial',
            trialStartDate: new Date(),
            trialEndDate: trialEndDate,
            planType: 'free_trial',
            createdAt: new Date()
        });

        console.log("New user added to Firestore with trial:", facebookId)
    } else {
        // Update user access token
        await userRef.update({ accessToken });

        // Check if payment status exists, create if missing
        const paymentRef = db.collection("users").doc(facebookId).collection("paymentStatus").doc("subscription");
        const paymentDoc = await paymentRef.get();

        if (!paymentDoc.exists) {
            const trialEndDate = new Date();
            trialEndDate.setDate(trialEndDate.getDate() + 14);

            await paymentRef.set({
                subscriptionStatus: 'trial',
                trialStartDate: userDoc.data().createdAt || new Date(),
                trialEndDate: trialEndDate,
                planType: 'free_trial',
                createdAt: new Date()
            });

            console.log("Added payment status to existing user:", facebookId);
        }

        console.log("User token updated:", facebookId)
    }
}

// Get user data by Facebook ID
async function getUserByFacebookId(facebookId) {
    const userRef = db.collection("users").doc(facebookId)
    const userDoc = await userRef.get()
    return userDoc.exists ? userDoc.data() : null
}

// Global Settings (per user)
async function saveGlobalSettings(facebookId, globalSettings) {
    const globalRef = db.collection("users").doc(facebookId).collection("settings").doc("global");
    await globalRef.set(globalSettings, { merge: true });
}

// Ad Account Settings (per user per ad account)
async function saveAdAccountSettings(facebookId, adAccountId, adAccountSettings) {
    const adAccountRef = db
        .collection("users")
        .doc(facebookId)
        .collection("adAccounts")
        .doc(adAccountId);

    await adAccountRef.set(adAccountSettings, { merge: true });
}

async function getGlobalSettings(facebookId) {
    const docRef = db.collection("users").doc(facebookId).collection("settings").doc("global");
    const docSnap = await docRef.get();
    return docSnap.exists ? docSnap.data() : null;
}

// Get ad account settings
async function getAdAccountSettings(facebookId, adAccountId) {
    const docRef = db.collection("users").doc(facebookId).collection("adAccounts").doc(adAccountId);
    const docSnap = await docRef.get();
    return docSnap.exists ? docSnap.data() : null;
}

async function deleteCopyTemplate(facebookId, adAccountId, templateName) {
    const adAccountRef = db
        .collection("users")
        .doc(facebookId)
        .collection("adAccounts")
        .doc(adAccountId);

    const adDoc = await adAccountRef.get();
    const data = adDoc.data();

    const isDefault = data?.defaultTemplateName === templateName;
    const templates = data?.copyTemplates || {};

    // Remove the template from local object
    delete templates[templateName];

    const updatePayload = {
        [`copyTemplates.${templateName}`]: admin.firestore.FieldValue.delete()
    };

    // If it was default, and we still have other templates left
    const remainingTemplateNames = Object.keys(templates);
    if (isDefault) {
        if (remainingTemplateNames.length > 0) {
            updatePayload.defaultTemplateName = remainingTemplateNames[0]; // Set new default
        } else {
            updatePayload.defaultTemplateName = admin.firestore.FieldValue.delete(); // Clear it
        }
    }

    await adAccountRef.update(updatePayload);

    return true;
}

// === SIMPLIFIED SUBSCRIPTION METHODS ===

// Get subscription status and details
async function getSubscriptionStatus(facebookId) {
    const paymentRef = db.collection("users").doc(facebookId).collection("paymentStatus").doc("subscription");
    const paymentDoc = await paymentRef.get();

    if (!paymentDoc.exists) {
        // Create payment status for existing user
        const userRef = db.collection("users").doc(facebookId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return null;

        const trialEndDate = new Date();
        trialEndDate.setDate(trialEndDate.getDate() + 14);

        const subscriptionFields = {
            subscriptionStatus: 'trial',
            trialStartDate: userDoc.data().createdAt || new Date(),
            trialEndDate: trialEndDate,
            planType: 'free_trial',
            createdAt: new Date()
        };

        await paymentRef.set(subscriptionFields);

        // Return the new data
        return {
            ...subscriptionFields,
            trialDaysLeft: 14,
            isTrialExpired: false
        };
    }

    const paymentData = paymentDoc.data();
    const now = new Date();

    // Calculate trial days left
    let trialDaysLeft = 0;
    let isTrialExpired = false;

    if (paymentData.subscriptionStatus === 'trial' && paymentData.trialEndDate) {
        const trialEnd = paymentData.trialEndDate.toDate ? paymentData.trialEndDate.toDate() : new Date(paymentData.trialEndDate);
        trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
        isTrialExpired = trialDaysLeft <= 0;
    }

    return {
        subscriptionStatus: paymentData.subscriptionStatus,
        planType: paymentData.planType || 'free_trial',
        trialStartDate: paymentData.trialStartDate,
        trialEndDate: paymentData.trialEndDate,
        trialDaysLeft,
        isTrialExpired
    };
}

// Check if user has active access
async function hasActiveAccess(facebookId) {
    const subscriptionData = await getSubscriptionStatus(facebookId);
    if (!subscriptionData) return false;

    return subscriptionData.subscriptionStatus === 'active' ||
        (subscriptionData.subscriptionStatus === 'trial' && !subscriptionData.isTrialExpired);
}

// Update subscription status (simplified)
async function updateSubscriptionStatus(facebookId, subscriptionData) {
    const paymentRef = db.collection("users").doc(facebookId).collection("paymentStatus").doc("subscription");
    await paymentRef.update({
        ...subscriptionData,
        updatedAt: new Date()
    });
}

// Extend trial (admin function)
async function extendTrial(facebookId, additionalDays) {
    const paymentRef = db.collection("users").doc(facebookId).collection("paymentStatus").doc("subscription");
    const paymentDoc = await paymentRef.get();

    if (!paymentDoc.exists) return false;

    const paymentData = paymentDoc.data();
    const currentTrialEnd = paymentData.trialEndDate?.toDate ? paymentData.trialEndDate.toDate() : new Date(paymentData.trialEndDate);
    const newTrialEnd = new Date(currentTrialEnd);
    newTrialEnd.setDate(newTrialEnd.getDate() + additionalDays);

    await paymentRef.update({
        trialEndDate: newTrialEnd,
        subscriptionStatus: 'trial',
        updatedAt: new Date()
    });

    return true;
}

module.exports = {
    createOrUpdateUser,
    getUserByFacebookId,
    saveGlobalSettings,
    saveAdAccountSettings,
    getGlobalSettings,
    getAdAccountSettings,
    deleteCopyTemplate,
    // Simplified subscription methods
    getSubscriptionStatus,
    updateSubscriptionStatus,
    hasActiveAccess,
    extendTrial
};