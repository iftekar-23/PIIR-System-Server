const express = require('express')
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require("dotenv").config();
const admin = require("firebase-admin");

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// middleware 
app.use(cors());
app.use(express.json())

var serviceAccount = require("./piir-system-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const verifyFBToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).send({ message: "unauthorized" });

        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded_email = decoded.email;
        next();
    } catch (err) {
        return res.status(401).send({ message: "unauthorized" });
    }
};



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1yqh28p.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {

        const db = client.db("piir_system_db");
        const issuesCollection = db.collection("issues");
        const usersCollection = db.collection("users");
        const votesCollection = db.collection("issueVotes");
        const paymentsCollection = db.collection("payments");


        const logTimeline = async (issueId, action, updatedBy = "System") => {
            const entry = {
                action,
                updatedBy,
                date: new Date().toISOString()
            };

            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $push: { timeline: { $each: [entry], $position: 0 } } }
            );
        };

        // Load all issues
        app.get("/issues", async (req, res) => {
            const result = await issuesCollection.find().toArray();
            res.send(result);
        });

        // Add new issue
        app.post("/issues", async (req, res) => {
            const data = req.body;
            data.timeline = [];

            const result = await issuesCollection.insertOne(data);

            await logTimeline(result.insertedId, "Issue reported by citizen", data.userEmail);

            res.send(result);
        });

        // Get single issue
        app.get("/issues/:id", async (req, res) => {
            const id = req.params.id;
            const result = await issuesCollection.findOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // Update Issue
        app.patch("/issues/:id", async (req, res) => {
            const id = req.params.id;
            const updatedData = req.body;
            const result = await issuesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: updatedData }
            );
            res.send(result);
        });


        app.patch("/issues/status/:id", async (req, res) => {
            const id = req.params.id;
            const { newStatus, updatedBy } = req.body;

            await issuesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: newStatus } }
            );

            await logTimeline(id, `Status changed to ${newStatus}`, updatedBy);

            res.send({ success: true });
        });


        // Delete Issue
        app.delete("/issues/:id", async (req, res) => {
            const id = req.params.id;
            const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // Users API

        // Get all users
        app.get("/users", async (req, res) => {
            try {
                const searchText = req.query.searchText || "";
                const query = {};

                if (searchText) {
                    query.$or = [
                        { name: { $regex: searchText, $options: 'i' } },
                        { email: { $regex: searchText, $options: 'i' } }
                    ];
                }

                const result = await usersCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .limit(50)
                    .toArray();

                res.send(result);
            } catch (err) {
                console.error("GET /users error:", err);
                res.status(500).send({ message: "Server error" });
            }
        });


        app.post("/users", async (req, res) => {
            try {
                const { email, name, photoURL } = req.body;
                if (!email) return res.status(400).send({ success: false, message: "Email required" });

                const filter = { email };

                const update = {
                    $setOnInsert: {
                        email,
                        role: "citizen",
                        createdAt: new Date(),
                    },
                    $set: {
                        name: name || "",
                        photoURL: photoURL || "",
                    }
                };

                const result = await usersCollection.updateOne(filter, update, { upsert: true });
                const user = await usersCollection.findOne({ email });

                res.send({ success: true, user, result });

            } catch (err) {
                console.error("save-user error:", err);
                res.status(500).send({ success: false, message: "Server error" });
            }
        });



        app.get("/users/role/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });
                res.send({ role: user?.role || "citizen" });
            } catch (err) {
                console.error("get role error:", err);
                res.status(500).send({ role: "citizen" });
            }
        });

        app.patch("/users/role/:email", async (req, res) => {
            try {
                // verifyFBToken sets req.decoded_email
                const requesterEmail = req.decoded_email;
                if (!requesterEmail) return res.status(401).send({ message: "unauthorized" });

                const requester = await usersCollection.findOne({ email: requesterEmail });
                if (!requester || requester.role !== "admin") {
                    return res.status(403).send({ message: "forbidden: admin only" });
                }

                const targetEmail = req.params.email;
                const { role } = req.body;
                if (!["admin", "staff", "citizen"].includes(role)) {
                    return res.status(400).send({ message: "invalid role" });
                }

                const result = await usersCollection.updateOne(
                    { email: targetEmail },
                    { $set: { role } }
                );

                res.send({ success: true, result });
            } catch (err) {
                console.error("patch role error:", err);
                res.status(500).send({ message: "server error" });
            }
        });


        // UPVOTE API (no need to modify your issues structure)
        app.patch("/issues/upvote/:id", async (req, res) => {
            const issueId = req.params.id;
            const userEmail = req.body.email;

            const issue = await issuesCollection.findOne({ _id: new ObjectId(issueId) });

            if (issue.userEmail === userEmail) {
                return res.status(400).send({ message: "You cannot upvote your own issue" });
            }

            const alreadyVote = await votesCollection.findOne({ issueId, userEmail });

            if (alreadyVote) {
                return res.status(400).send({ message: "Already upvoted" });
            }

            await votesCollection.insertOne({ issueId, userEmail });

            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $inc: { upvotes: 1 } }
            );

            res.send({ success: true, message: "Upvote added" });
        });


        // payments related api

        app.post("/boost-issue", async (req, res) => {
            const { issueId, userEmail } = req.body;

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ["card"],
                line_items: [
                    {
                        price_data: {
                            currency: "usd",
                            unit_amount: 100 * 100,
                            product_data: {
                                name: `Boost Issue Priority`,
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: "payment",
                customer_email: userEmail,
                metadata: { issueId },
                success_url: `${process.env.CLIENT_URL}/boost-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.CLIENT_URL}/boost-failed`,
            });

            res.send({ url: session.url });
        });



        app.get("/boost-success", async (req, res) => {
            const session = await stripe.checkout.sessions.retrieve(
                req.query.session_id
            );
            const issueId = session.metadata.issueId;

            // update priority
            await issuesCollection.updateOne(
                { _id: new ObjectId(issueId) },
                { $set: { priority: "high" } }
            );

            await logTimeline(issueId, "Issue Boosted (Priority set to High)");

            // store payment
            const payment = {
                issueId,
                amount: session.amount_total / 100,
                email: session.customer_email,
                transactionId: session.payment_intent,
                paidAt: new Date(),
            };

            await paymentsCollection.insertOne(payment);

            res.send({ success: true });
        });



        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("MongoDB Connected Successfully!");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('PIIR-System Running Successfully!')
})

app.listen(port, () => {
    console.log(`Server running on port ${port}`)
})
