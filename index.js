// index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin Initialization
const serviceAccount = require("./piir-system-firebase-adminsdk.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// Verify Firebase Token Middleware
const verifyFBToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).send({ message: "Unauthorized" });
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded_email = decoded.email;
        next();
    } catch {
        return res.status(401).send({ message: "Unauthorized" });
    }
};

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1yqh28p.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
    try {
        await client.connect();
        const db = client.db("piir_system_db");
        const issuesCollection = db.collection("issues");
        const usersCollection = db.collection("users");
        const votesCollection = db.collection("issueVotes");
        const paymentsCollection = db.collection("payments");

        console.log("MongoDB Connected Successfully!");


        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const user = await usersCollection.findOne({ email });
            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: "Admin only route" });
            }
            next();
        };

        // Helper: Get User by Email
        const getUserByEmail = async (email) => {
            if (!email) return null;
            return await usersCollection.findOne({ email });
        };

        // Helper: Add Timeline Entry
        const logTimeline = async (issueId, action, updatedBy = "System") => {
            const entry = { action, updatedBy, date: new Date().toISOString() };
            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $push: { timeline: { $each: [entry], $position: 0 } } }
            );
        };

        /** ------------------ ISSUES ------------------ **/

        // Get all issues
        app.get("/issues", async (req, res) => {
            try {
                const result = await issuesCollection.find().toArray();
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Get single issue
        app.get("/issues/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });
                res.send(issue);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Create new issue (secured)
        app.post("/issues", verifyFBToken, async (req, res) => {
            try {
                const data = req.body;
                const userEmail = req.decoded_email;

                if (userEmail !== data.userEmail) return res.status(403).send({ message: "Unauthorized" });

                const user = await getUserByEmail(userEmail);
                if (!user) return res.status(404).send({ message: "User not found" });
                if (user.isBlocked) return res.status(403).send({ message: "You are blocked. Contact support." });

                const userIssueCount = await issuesCollection.countDocuments({ userEmail });
                if (!user.isPremium && userIssueCount >= 3)
                    return res.status(403).send({ message: "Free limit reached. Subscribe to submit more issues." });

                const issueDoc = {
                    title: data.title,
                    description: data.description,
                    category: data.category,
                    imageURL: data.imageURL || "",
                    location: data.location || "",
                    userEmail,
                    status: "Pending",
                    upvotes: 0,
                    priority: data.priority || "normal",
                    timeline: [
                        { action: "Issue reported by citizen", updatedBy: userEmail, date: new Date().toISOString() },
                    ],
                    createdAt: new Date(),
                };

                const result = await issuesCollection.insertOne(issueDoc);
                res.send({ success: true, insertedId: result.insertedId });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Update issue (secured)
        app.patch("/issues/:id", verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const updated = req.body;
                const userEmail = req.decoded_email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });
                if (issue.userEmail !== userEmail) return res.status(403).send({ message: "Not owner" });
                if (issue.status !== "pending") return res.status(400).send({ message: "Only pending issues can be edited" });

                await issuesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: updated,
                        $push: {
                            timeline: {
                                $each: [
                                    { action: "Issue edited by user", updatedBy: userEmail, date: new Date().toISOString() },
                                ],
                                $position: 0,
                            },
                        },
                    }
                );

                const newIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                res.send({ success: true, issue: newIssue });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Delete issue (secured)
        app.delete("/issues/:id", verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const userEmail = req.decoded_email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });
                if (issue.userEmail !== userEmail) return res.status(403).send({ message: "Not owner" });

                await issuesCollection.deleteOne({ _id: new ObjectId(id) });
                await votesCollection.deleteMany({ issueId: id });

                res.send({ success: true });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Upvote issue (secured)
        app.patch("/issues/upvote/:id", verifyFBToken, async (req, res) => {
            try {
                const issueId = req.params.id;
                const userEmail = req.decoded_email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });
                if (!issue) return res.status(404).send({ message: "Issue not found" });
                if (issue.userEmail === userEmail) return res.status(400).send({ message: "Cannot upvote own issue" });

                const alreadyVote = await votesCollection.findOne({ issueId, userEmail });
                if (alreadyVote) return res.status(400).send({ message: "Already upvoted" });

                await votesCollection.insertOne({ issueId, userEmail });
                await issuesCollection.updateOne({ _id: new ObjectId(issueId) }, { $inc: { upvotes: 1 } });

                res.send({ success: true, message: "Upvote added" });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        /** ------------------ USERS ------------------ **/

        // Save or update user
        app.post("/users", async (req, res) => {
            try {
                const { email, name, photoURL } = req.body;
                if (!email) return res.status(400).send({ success: false, message: "Email required" });

                const filter = { email };
                const update = {
                    $setOnInsert: { email, role: "citizen", isPremium: false, isBlocked: false, createdAt: new Date() },
                    $set: { name: name || "", photoURL: photoURL || "" },
                };

                const result = await usersCollection.updateOne(filter, update, { upsert: true });
                const user = await usersCollection.findOne({ email });
                res.send({ success: true, user, result });
            } catch (err) {
                console.error(err);
                res.status(500).send({ success: false, message: "Server error" });
            }
        });

        // Get single user by email (secured)
        app.get("/users/:email", verifyFBToken, async (req, res) => {
            try {
                const email = req.params.email;

                if (req.decoded_email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const user = await usersCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send(user);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });


        // Get role
        app.get("/users/role/:email", async (req, res) => {
            try {
                const email = req.params.email;
                let user = await usersCollection.findOne({ email });

                // If user doesn't exist, create a default citizen
                if (!user) {
                    const newUser = {
                        email,
                        role: "citizen",
                        isPremium: false,
                        isBlocked: false,
                        createdAt: new Date()
                    };
                    await usersCollection.insertOne(newUser);
                    user = newUser;
                }

                res.send({ role: user.role || "citizen" });
            } catch (err) {
                console.error(err);
                res.status(500).send({ role: "citizen" });
            }
        });


        // Update user profile (secured)
        app.patch("/users/:email", verifyFBToken, async (req, res) => {
            try {
                const email = req.params.email;
                if (req.decoded_email !== email) return res.status(403).send({ message: "Forbidden" });

                const updatedData = req.body;
                await usersCollection.updateOne({ email }, { $set: updatedData });
                const updatedUser = await usersCollection.findOne({ email });
                res.send({ success: true, user: updatedUser });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });



        /** ------------------ DASHBOARD STATS ------------------ **/
        app.get("/dashboard/citizen/stats", verifyFBToken, async (req, res) => {
            try {
                const email = req.query.email;

                if (!email || req.decoded_email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const total = await issuesCollection.countDocuments({
                    userEmail: email,
                });

                const pending = await issuesCollection.countDocuments({
                    userEmail: email,
                    status: "Pending",
                });

                const inProgress = await issuesCollection.countDocuments({
                    userEmail: email,
                    status: "In Progress",
                });

                const working = await issuesCollection.countDocuments({
                    userEmail: email,
                    status: "Working",
                });

                const resolved = await issuesCollection.countDocuments({
                    userEmail: email,
                    status: "Resolved",
                });

                const closed = await issuesCollection.countDocuments({
                    userEmail: email,
                    status: "Closed",
                });

                const payments = await paymentsCollection.countDocuments({
                    email,
                });

                res.send({
                    total,
                    pending,
                    inProgress,
                    working,
                    resolved,
                    closed,
                    payments,
                });
            } catch (err) {
                console.error("Citizen stats error:", err);
                res.status(500).send({ message: "Server error" });
            }
        });


        /** ------------------ SUBSCRIBE / BOOST ISSUE ------------------ **/
        app.post("/boost-issue", async (req, res) => {
            try {
                const { issueId, userEmail } = req.body;
                const user = await getUserByEmail(userEmail);
                if (!user) return res.status(404).send({ message: "User not found" });

                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    line_items: [
                        {
                            price_data: {
                                currency: "usd",
                                unit_amount: 100 * 100, // 100 TK in cents
                                product_data: { name: `Boost Issue ${issueId}` },
                            },
                            quantity: 1,
                        },
                    ],
                    mode: "payment",
                    customer_email: userEmail,
                    success_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/boost-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/issues`,
                    metadata: { issueId, userEmail },
                });

                res.send({ url: session.url });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        app.get("/payments/boost-success", async (req, res) => {
            try {
                const sessionId = req.query.session_id;
                if (!sessionId) {
                    return res.status(400).send({ message: "session_id missing" });
                }

                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== "paid") {
                    return res.status(400).send({ message: "Payment not completed" });
                }

                const { issueId, userEmail } = session.metadata;

                await issuesCollection.updateOne(
                    { _id: new ObjectId(issueId) },
                    {
                        $set: { priority: "High" },
                        $push: {
                            timeline: {
                                action: "Issue boosted to High priority",
                                updatedBy: userEmail,
                                date: new Date().toISOString(),
                            },
                        },
                    }
                );

                await paymentsCollection.insertOne({
                    issueId,
                    email: userEmail,
                    amount: session.amount_total,
                    createdAt: new Date(),
                });

                res.send({
                    success: true,
                    issueId
                });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // SUBSCRIBE TO PREMIUM (Citizen)
        app.post("/subscribe", verifyFBToken, async (req, res) => {
            try {
                const { email } = req.body;

                if (req.decoded_email !== email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(404).send({ message: "User not found" });

                if (user.isPremium) {
                    return res.status(400).send({ message: "Already premium user" });
                }

                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    mode: "payment",
                    customer_email: email,
                    line_items: [
                        {
                            price_data: {
                                currency: "bdt",
                                unit_amount: 1000 * 100, // 1000 TK
                                product_data: {
                                    name: "CityFix Premium Subscription",
                                },
                            },
                            quantity: 1,
                        },
                    ],
                    success_url: `${process.env.FRONTEND_URL}/subscribe-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.FRONTEND_URL}/dashboard/citizen-profile`,
                    metadata: { email },
                });

                res.send({ url: session.url });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        app.get("/payments/subscribe-success", async (req, res) => {
            try {
                const sessionId = req.query.session_id;
                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== "paid") {
                    return res.status(400).send({ message: "Payment not completed" });
                }

                const email = session.metadata.email;

                // Update user to premium
                await usersCollection.updateOne(
                    { email },
                    { $set: { isPremium: true } }
                );

                // Save payment
                await paymentsCollection.insertOne({
                    email,
                    amount: session.amount_total,
                    type: "subscription",
                    createdAt: new Date(),
                });

                res.redirect(`${process.env.FRONTEND_URL}/dashboard/citizen-profile`);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });



        // STAFF — Get issues assigned to a specific staff
        app.get("/dashboard/staff/issues", verifyFBToken, async (req, res) => {
            try {
                const email = req.query.email;
                if (!email || req.decoded_email !== email)
                    return res.status(403).send({ message: "Forbidden" });

                const issues = await issuesCollection
                    .find({ assignedTo: email })
                    .sort({ priority: -1 }) // high → normal
                    .toArray();

                res.send(issues);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // STAFF — Dashboard stats
        app.get("/dashboard/staff/stats", async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const baseQuery = { assignedTo: email };

                // total assigned
                const assigned = await issuesCollection.countDocuments(baseQuery);

                // resolved issues
                const resolved = await issuesCollection.countDocuments({
                    ...baseQuery,
                    status: "Resolved",
                });

                // closed issues
                const closed = await issuesCollection.countDocuments({
                    ...baseQuery,
                    status: "Closed",
                });

                // today's updated tasks
                const startOfDay = new Date();
                startOfDay.setHours(0, 0, 0, 0);

                const todaysTasks = await issuesCollection.countDocuments({
                    ...baseQuery,
                    updatedAt: { $gte: startOfDay },
                });

                // recent activity (group by status)
                const recentActivity = await issuesCollection
                    .aggregate([
                        { $match: baseQuery },
                        {
                            $group: {
                                _id: "$status",
                                count: { $sum: 1 },
                            },
                        },
                        {
                            $project: {
                                _id: 0,
                                label: "$_id",
                                count: 1,
                            },
                        },
                    ])
                    .toArray();

                res.send({
                    assigned,
                    resolved,
                    closed,
                    todaysTasks,
                    recentActivity,
                });
            } catch (error) {
                console.error("Staff stats error:", error);
                res.status(500).send({ message: "Failed to load staff stats" });
            }
        });



        // STAFF — Update issue status
        app.patch("/dashboard/staff/status/:id", verifyFBToken, async (req, res) => {
            try {
                const issueId = req.params.id;
                const { newStatus } = req.body;
                const staffEmail = req.decoded_email;

                const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

                if (!issue) return res.status(404).send({ message: "Issue not found" });
                if (issue.assignedTo !== staffEmail)
                    return res.status(403).send({ message: "Not your issue" });


                const valid = {
                    Pending: ["In Progress"],
                    "In Progress": ["Working"],
                    Working: ["Resolved"],
                    Resolved: ["Closed"]
                };


                if (!valid[issue.status]?.includes(newStatus))
                    return res.status(400).send({ message: "Invalid status transition" });

                await issuesCollection.updateOne(
                    { _id: new ObjectId(issueId) },
                    { $set: { status: newStatus } }
                );

                await logTimeline(issueId, `Status changed to ${newStatus}`, staffEmail);

                const updated = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

                res.send({ success: true, issue: updated });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });


        app.patch("/staff/profile/:email", verifyFBToken, async (req, res) => {
            try {
                const email = req.params.email;
                if (req.decoded_email !== email) return res.status(403).send({ message: "Forbidden" });

                const updated = req.body;
                await usersCollection.updateOne({ email }, { $set: updated });

                const newUser = await usersCollection.findOne({ email });
                res.send({ success: true, user: newUser });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });

        // Admin related apis

        app.get("/admin/dashboard/stats", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const totalIssues = await issuesCollection.countDocuments();

                const pendingIssues = await issuesCollection.countDocuments({
                    status: "Pending",
                });

                const resolvedIssues = await issuesCollection.countDocuments({
                    status: "Resolved",
                });

                const closedIssues = await issuesCollection.countDocuments({
                    status: "Closed",
                });

                const paymentsAgg = await paymentsCollection.aggregate([
                    { $group: { _id: null, total: { $sum: "$amount" } } },
                ]).toArray();

                res.send({
                    totalIssues,
                    pendingIssues,
                    resolvedIssues,
                    closedIssues,
                    totalPayments: paymentsAgg[0]?.total || 0,
                });
            } catch (err) {
                console.error("Admin stats error:", err);
                res.status(500).send({ message: "Failed to load admin stats" });
            }
        });



        app.get("/admin/issues", verifyFBToken, verifyAdmin, async (req, res) => {
            const issues = await issuesCollection
                .find()
                .sort({ priority: -1, createdAt: -1 })
                .toArray();

            res.send(issues);
        });

        app.patch("/admin/issues/:id/assign", verifyFBToken, verifyAdmin, async (req, res) => {
            const issueId = req.params.id;
            const { staffEmail } = req.body;

            const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });
            if (!issue) return res.status(404).send({ message: "Issue not found" });
            if (issue.assignedTo)
                return res.status(400).send({ message: "Already assigned" });

            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $set: { assignedTo: staffEmail } }
            );

            await logTimeline(issueId, `Assigned to staff: ${staffEmail}`, "Admin");

            res.send({ success: true });
        });


        app.patch("/admin/issues/:id/reject", verifyFBToken, verifyAdmin, async (req, res) => {
            const issueId = req.params.id;
            const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

            if (!issue) return res.status(404).send({ message: "Not found" });
            if (issue.status !== "pending")
                return res.status(400).send({ message: "Only pending issues can be rejected" });

            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $set: { status: "rejected" } }
            );

            await logTimeline(issueId, "Issue rejected by admin", "Admin");

            res.send({ success: true });
        });


        app.get("/admin/users", verifyFBToken, verifyAdmin, async (req, res) => {
            const users = await usersCollection.find({ role: "citizen" }).toArray();
            res.send(users);
        });

        app.patch("/admin/users/:email/block", verifyFBToken, verifyAdmin, async (req, res) => {
            await usersCollection.updateOne(
                { email: req.params.email },
                { $set: { isBlocked: true } }
            );
            res.send({ success: true });
        });

        app.patch("/admin/users/:email/unblock", verifyFBToken, verifyAdmin, async (req, res) => {
            await usersCollection.updateOne(
                { email: req.params.email },
                { $set: { isBlocked: false } }
            );
            res.send({ success: true });
        });


        app.post("/admin/staff", verifyFBToken, verifyAdmin, async (req, res) => {
            const { name, email, password, phone, photoURL } = req.body;

            const userRecord = await admin.auth().createUser({ email, password });

            await usersCollection.insertOne({
                name, email, phone, photoURL,
                role: "staff",
                isBlocked: false,
                createdAt: new Date()
            });

            res.send({ success: true });
        });


        app.get("/admin/staff", verifyFBToken, verifyAdmin, async (req, res) => {
            const staff = await usersCollection.find({ role: "staff" }).toArray();
            res.send(staff);
        });

        app.patch("/admin/staff/:email", verifyFBToken, verifyAdmin, async (req, res) => {
            await usersCollection.updateOne(
                { email: req.params.email },
                { $set: req.body }
            );
            res.send({ success: true });
        });

        app.delete("/admin/staff/:email", verifyFBToken, verifyAdmin, async (req, res) => {
            const user = await admin.auth().getUserByEmail(req.params.email);
            await admin.auth().deleteUser(user.uid);
            await usersCollection.deleteOne({ email: req.params.email });

            res.send({ success: true });
        });

        app.get("/admin/payments", verifyFBToken, verifyAdmin, async (req, res) => {
            const payments = await paymentsCollection.find().sort({ createdAt: -1 }).toArray();
            res.send(payments);
        });


    } finally {
        // Optionally: await client.close();
    }
}

run().catch(console.error);

// Test route
app.get("/", (req, res) => res.send("PIIR-System Running Successfully!"));

app.listen(port, () => console.log(`Server running on port ${port}`));
