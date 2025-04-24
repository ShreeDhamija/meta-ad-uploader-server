// middleware/verifyFirebaseToken.js
const { getAuth } = require("firebase-admin/auth");

async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing token" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = await getAuth().verifyIdToken(token);
        req.user = decoded; // Inject user info into request
        next();
    } catch (err) {
        console.error("Token verification failed:", err.message);
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

module.exports = verifyFirebaseToken;
