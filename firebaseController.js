const { db } = require("./firebase")
const admin = require("firebase-admin");


// Add or update user data
async function createOrUpdateUser({ facebookId, name, email, picture, accessToken }) {
    const userRef = db.collection("users").doc(facebookId)
    const userDoc = await userRef.get()

    if (!userDoc.exists) {
        await userRef.set({
            name,
            picture,
            email: email || null,
            accessToken,
            createdAt: new Date(),

        })
        console.log("New user added to Firestore:", facebookId)
    } else {
        await userRef.update({ accessToken })
        console.log("User already existed, token updated:", facebookId)
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

// firebaseController.js

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



module.exports = {
    createOrUpdateUser,
    getUserByFacebookId,
    saveGlobalSettings,
    saveAdAccountSettings,
    getGlobalSettings,
    getAdAccountSettings,
    deleteCopyTemplate,
};