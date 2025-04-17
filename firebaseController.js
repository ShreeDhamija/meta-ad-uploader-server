const { db } = require("./firebase")

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
            hasCompletedSignup: true,
            preferences: {
                checkboxA: false,
                dropdownValue: "default",
                textField: ""
            }
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

module.exports = {
    createOrUpdateUser,
    getUserByFacebookId
}
