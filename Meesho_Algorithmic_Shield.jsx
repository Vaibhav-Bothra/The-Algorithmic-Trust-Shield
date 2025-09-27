import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, updateDoc, getDocs, runTransaction } from 'firebase/firestore';

// --- CONFIGURATION AND INITIALIZATION ---

// Global Variables (Provided by the environment)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_authToken !== 'undefined' ? __initial_authToken : null;

let app, db, auth;
if (firebaseConfig) {
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
    } catch (e) {
        console.error("Firebase initialization failed:", e);
    }
}

// --- DUMMY DATA AND TRUST SCORE LOGIC ---

// Helper function to determine seller status based on score and shipment count
const getTrustDivision = (score, shipments) => {
    if (shipments <= 20) return { status: 'Newcomer', color: 'bg-blue-200 text-blue-800' };
    if (score > 85) return { status: 'Verified', color: 'bg-green-600 text-white font-bold' };
    if (score >= 60) return { status: 'Not Verified, Not Suspicious', color: 'bg-yellow-100 text-yellow-800' };
    if (score >= 30) return { status: 'Not Verified, Suspicious', color: 'bg-orange-300 text-orange-900' };
    return { status: 'Flagged (Score < 30)', color: 'bg-red-600 text-white font-bold' };
};

// Trust Score Calculation Logic (Simplified Linear Regression Model Simulation)
const calculateTrustScore = (seller, allProducts, allReviews, allComplaints) => {
    if (!seller || seller.totalShipments <= 20) return 50; 
    
    let baseScore = 50; 

    const sellerProductIds = allProducts.filter(p => p.sellerId === seller.id).map(p => p.id);
    const sellerReviews = allReviews.filter(r => sellerProductIds.includes(r.productId));
    const sellerComplaints = allComplaints.filter(c => c.sellerId === seller.id); // Filter complaints by seller ID

    // Metrics
    const avgRating = sellerReviews.length > 0 ? (sellerReviews.reduce((sum, r) => sum + r.rating, 0) / sellerReviews.length) : 4.0;
    const deliveryRate = seller.totalShipments > 0 ? (seller.successfulDeliveries / seller.totalShipments) : 0.8;
    const returnRate = 1 - deliveryRate; // Simplified: returns = failed deliveries
    const complaintRate = sellerComplaints.length / (seller.totalShipments || 10); // Complaints relative to volume

    // 2. Weighted Impacts (Simulation based on defined parameters)
    
    // a. Product Quality (Ratings & Returns) - HIGH WEIGHT (40%)
    baseScore += (avgRating - 4.0) * 10; // Reward/Penalize deviation from 4.0
    baseScore -= returnRate * 40;        // Penalize return rate

    // b. Operational Reliability (Deliveries & Shipments) - MEDIUM WEIGHT (30%)
    baseScore += (deliveryRate - 0.95) * 60; // Reward success over 95%

    // c. Risk & Behavior (Complaints & Payout) - HIGH PENALTY (30%)
    baseScore -= complaintRate * 150; // Heavy penalty for complaints (High impact factor)
    baseScore += (seller.payoutRatio - 0.9) * 20; // Reward high payout ratio (low financial risk)

    // Apply Hard Flags
    if (seller.isFlagged || seller.pan === 'FLAGGEDPAN') baseScore = 1; 

    return Math.max(0, Math.min(100, Math.round(baseScore)));
};

// --- APP CONTEXT SETUP ---

const AppContext = React.createContext(null);

const AppProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [profileView, setProfileView] = useState('customer');
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [sellers, setSellers] = useState([]);
    const [products, setProducts] = useState([]);
    const [reviews, setReviews] = useState([]);
    const [orders, setOrders] = useState([]);
    const [complaints, setComplaints] = useState([]);
    const [loading, setLoading] = useState(true);

    const dataReady = isAuthReady && db && userId;

    // 1. Initial Auth/DB Setup
    useEffect(() => {
        if (!db) {
            setIsAuthReady(true);
            setLoading(false);
            return;
        }

        const setupAuth = async () => {
            try {
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (e) {
                console.error("Auth sign-in failed:", e);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            if (currentUser) {
                setUser(currentUser);
                setUserId(currentUser.uid);
            } else {
                setUser(null);
                setUserId(null);
            }
            setIsAuthReady(true);
            setLoading(false);
        });

        setupAuth();
        return () => unsubscribe();
    }, [initialAuthToken]);

    // 2. Data Listeners (Firestore)
    useEffect(() => {
        if (!dataReady) return;

        const collectionPath = (name) => `artifacts/${appId}/public/data/${name}`;

        const unsubscribeSellers = onSnapshot(collection(db, collectionPath('sellers')), (snapshot) => {
            setSellers(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });

        const unsubscribeProducts = onSnapshot(collection(db, collectionPath('products')), (snapshot) => {
            setProducts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });

        const unsubscribeReviews = onSnapshot(collection(db, collectionPath('reviews')), (snapshot) => {
            setReviews(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });
        
        const unsubscribeOrders = onSnapshot(collection(db, collectionPath('orders')), (snapshot) => {
            setOrders(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });
        
        const unsubscribeComplaints = onSnapshot(collection(db, collectionPath('complaints')), (snapshot) => {
            setComplaints(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });

        return () => {
            unsubscribeSellers();
            unsubscribeProducts();
            unsubscribeReviews();
            unsubscribeOrders();
            unsubscribeComplaints();
        };
    }, [dataReady, appId, db]);

    // 3. TRUST SCORE UPDATE FUNCTION (Triggered Manually by Review/Complaint/Order)
    const updateSellerScore = useCallback(async (targetSellerId) => {
        if (!dataReady || !auth.currentUser) return;

        const seller = sellers.find(s => s.id === targetSellerId);
        if (!seller) return; 

        try {
            await runTransaction(db, async (transaction) => {
                const sellersRef = collection(db, `artifacts/${appId}/public/data/sellers`);
                const sellerDocRef = doc(sellersRef, targetSellerId);
                
                const docSnapshot = await transaction.get(sellerDocRef);

                if (docSnapshot.exists()) {
                    const latestSellerData = docSnapshot.data();
                    
                    // CRITICAL: Ensure we pass the latest data from the snapshot, not component state
                    const newScore = calculateTrustScore(latestSellerData, products, reviews, complaints);
                    const division = getTrustDivision(newScore, latestSellerData.totalShipments);

                    // Simulate parameter changes for visualization
                    const newTotalShipments = (latestSellerData.totalShipments || 0) + 1; 
                    const newSuccessfulDeliveries = (latestSellerData.successfulDeliveries || 0) + (Math.random() > 0.1 ? 1 : 0); 

                    transaction.update(sellerDocRef, {
                        trustScore: newScore,
                        trustStatus: division.status,
                        trustColor: division.color,
                        totalShipments: newTotalShipments,
                        successfulDeliveries: newSuccessfulDeliveries,
                        payoutRatio: Math.random() * (1 - 0.85) + 0.85, 
                    });
                }
            });
        } catch (e) {
            console.error("Transaction failed during score update: ", e);
        }
    }, [dataReady, sellers, products, reviews, complaints]);


    const value = useMemo(() => ({
        user,
        userId,
        profileView,
        setProfileView,
        sellers,
        products,
        reviews,
        orders,
        complaints,
        dataReady,
        loading,
        db,
        appId,
        updateSellerScore
    }), [user, userId, profileView, sellers, products, reviews, orders, complaints, dataReady, loading, db, appId, updateSellerScore]);

    if (loading) return <div className="text-center p-8 text-gray-700">Loading Application...</div>;

    return (
        <AppContext.Provider value={value}>
            <App />
        </AppContext.Provider>
    );
};

const Header = () => {
    const { profileView, setProfileView, userId } = React.useContext(AppContext);
    return (
        <header className="bg-purple-700 text-white p-4 shadow-lg flex justify-between items-center fixed top-0 w-full z-10">
            <h1 className="text-2xl font-extrabold tracking-tight">
                Meesho Trust-Shield Prototype
            </h1>
            <div className="flex items-center space-x-4">
                <button
                    onClick={() => setProfileView('customer')}
                    className={`px-3 py-1 rounded-full text-sm font-semibold transition-colors ${profileView === 'customer' ? 'bg-white text-purple-700 shadow-md' : 'hover:bg-purple-600'}`}
                >
                    Customer View
                </button>
                <button
                    onClick={() => setProfileView('seller')}
                    className={`px-3 py-1 rounded-full text-sm font-semibold transition-colors ${profileView === 'seller' ? 'bg-white text-purple-700 shadow-md' : 'hover:bg-purple-600'}`}
                >
                    Seller View
                </button>
                <div className="text-xs opacity-70">
                    User ID: {userId ? `${userId.substring(0, 4)}...` : 'Guest'}
                </div>
            </div>
        </header>
    );
};

// --------------------------------------------------------
// --- SHARED COMPONENTS (MUST be defined before dashboards) ---
// --------------------------------------------------------

const TrustPill = ({ status, color }) => (
    <span className={`px-3 py-1 rounded-full text-xs font-bold ${color}`}>
        {status}
    </span>
);

const StarRating = ({ rating, count }) => {
    const fullStars = Math.floor(rating);
    const halfStar = rating % 1 !== 0;
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);

    return (
        <div className="flex items-center text-yellow-500 text-lg">
            {[...Array(fullStars)].map((_, i) => <svg key={`f-${i}`} className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>)}
            {halfStar && <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26 6.91.75-5 4.87 1.18 6.88L12 17.27V2z"/></svg>}
            {[...Array(emptyStars)].map((_, i) => <svg key={`e-${i}`} className="w-5 h-5 fill-current text-gray-300" viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>)}
            {count > 0 && <span className="ml-2 text-sm text-gray-500">({count})</span>}
        </div>
    );
};

const ProductCard = ({ product }) => {
    const { sellers } = React.useContext(AppContext);
    const seller = sellers.find(s => s.id === product.sellerId);
    const trustDivision = getTrustDivision(seller?.trustScore, seller?.totalShipments);

    return (
        <div className="bg-white rounded-xl shadow-lg hover:shadow-xl transition duration-300 overflow-hidden border border-gray-100">
            <div className="h-40 bg-gray-200 flex items-center justify-center text-gray-500 font-medium">
                [Product Image Placeholder]
            </div>
            <div className="p-4">
                <h3 className="text-lg font-bold text-gray-800 truncate">{product.name}</h3>
                <p className="text-sm text-gray-500 mb-2 truncate">{product.details}</p>

                <div className="flex items-center space-x-2">
                    <StarRating rating={product.rating || 0} count={product.reviewCount || 0} />
                </div>

                <div className="flex items-end justify-between mt-3">
                    <p className="text-xl font-extrabold text-green-600">
                        ₹{(product.mrp * (1 - product.discount / 100)).toFixed(0)}
                    </p>
                    <p className="text-sm text-gray-400 line-through">
                        MRP: ₹{product.mrp.toFixed(0)}
                    </p>
                </div>
                
                <div className="mt-3 p-2 bg-gray-50 rounded-lg text-xs">
                    <p className="text-gray-600 font-medium">Seller: {seller?.name || 'Unknown'}</p>
                    <p className="mt-1 flex items-center">
                        <span className="font-semibold mr-2">Trust Status:</span>
                        <TrustPill status={trustDivision.status} color={trustDivision.color} />
                    </p>
                </div>
            </div>
        </div>
    );
};


// --- SELLER COMPONENTS ---

const SellerVerification = ({ sellerId, currentSeller }) => {
    const { db, appId, sellers } = React.useContext(AppContext);
    const [step, setStep] = useState(1);
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [docData, setDocData] = useState({ pan: '', gst: '' });
    const [feedback, setFeedback] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    const isExisting = sellers.some(s => s.id === sellerId);

    const handleSendOtp = () => {
        setFeedback('OTP simulated and sent! Check your console or use 123456.');
        setStep(2);
    };

    const handleVerify = async () => {
        if (otp !== '123456') { // Dummy OTP
            setFeedback('Invalid OTP. Please try 123456.');
            return;
        }
        setFeedback('OTP verified. Processing documents...');
        setStep(3);
    };

    const handleDocumentSubmit = async () => {
        setIsProcessing(true);
        setFeedback('Submitting documents and checking against flag database...');
        
        // Simulate flagged check (e.g., check PAN against a banned list)
        const isFlagged = docData.pan === 'FLAGGEDPAN';

        if (isFlagged) {
            setFeedback('Verification Failed: This identity is linked to a previously flagged account (PAN: FLAGGEDPAN).');
            setIsProcessing(false);
            return;
        }

        // Final registration
        try {
            // Ensure the current user is authenticated before attempting to write to Firestore
            if (!auth.currentUser) {
                setFeedback('Error: User not authenticated. Cannot register.');
                setIsProcessing(false);
                return;
            }

            await setDoc(doc(db, `artifacts/${appId}/public/data/sellers`, sellerId), {
                id: sellerId,
                name: `Seller ${sellerId.substring(0, 8)}`,
                email: email,
                pan: docData.pan,
                gst: docData.gst,
                trustScore: 50,
                trustStatus: 'Newcomer',
                trustColor: 'bg-blue-200 text-blue-800',
                totalShipments: 0,
                successfulDeliveries: 0,
                isFlagged: false,
                problemResolutionTime: 0,
                stockToOrderRatio: 1,
                payoutRatio: 1,
                createdAt: new Date(),
            });
            setFeedback('Verification successful! You can now list products.');
        } catch (e) {
            setFeedback('Error during registration: ' + e.message);
        } finally {
            setIsProcessing(false);
        }
    };

    if (isExisting) {
        return (
            <div className="p-6 bg-green-50 rounded-xl border border-green-200 shadow-md">
                <h3 className="text-xl font-bold text-green-700">Seller Verified & Active! (Phase 1 Complete)</h3>
                <p className="mt-2 text-gray-600">You have completed the KYC and Vetting process. Your Trust Score is now being calculated.</p>
                <p className="mt-4 text-sm font-semibold">Current Status: <TrustPill status={currentSeller?.trustStatus || 'Active'} color={currentSeller?.trustColor || 'bg-gray-300 text-gray-800'} /></p>
            </div>
        );
    }

    return (
        <div className="p-6 bg-white rounded-xl shadow-2xl">
            <h2 className="text-2xl font-bold text-purple-700 mb-4">Seller Onboarding & Verification (Phase 1)</h2>
            <p className="text-sm text-red-500 mb-4 font-semibold">
                *Minimum necessity check: Must pass to list products.
            </p>
            <div className="space-y-4">
                {step === 1 && (
                    <>
                        <input
                            type="email"
                            placeholder="Email / Phone"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                        />
                        <button
                            onClick={handleSendOtp}
                            disabled={isProcessing || !email}
                            className="w-full p-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition duration-150 disabled:bg-gray-400"
                        >
                            Send Verification OTP
                        </button>
                    </>
                )}
                {step === 2 && (
                    <>
                        <input
                            type="text"
                            placeholder="Enter OTP (Use 123456)"
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                        />
                        <button
                            onClick={handleVerify}
                            disabled={isProcessing || otp.length !== 6}
                            className="w-full p-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition duration-150 disabled:bg-gray-400"
                        >
                            Verify OTP
                        </button>
                    </>
                )}
                {step === 3 && (
                    <>
                        <p className="text-lg font-medium text-gray-700">Document Validation (AI-OCR Simulation)</p>
                        <input
                            type="text"
                            placeholder="PAN (Try FLAGGEDPAN to fail initial vetting)"
                            value={docData.pan}
                            onChange={(e) => setDocData({ ...docData, pan: e.target.value })}
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                        />
                        <input
                            type="text"
                            placeholder="GSTIN"
                            value={docData.gst}
                            onChange={(e) => setDocData({ ...docData, gst: e.target.value })}
                            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                        />
                        <button
                            onClick={handleDocumentSubmit}
                            disabled={isProcessing || !docData.pan || !docData.gst}
                            className="w-full p-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition duration-150 disabled:bg-gray-400"
                        >
                            Complete Verification & Register
                        </button>
                    </>
                )}
                {feedback && <p className={`mt-4 p-3 rounded-lg text-sm ${feedback.includes('Failed') ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>{feedback}</p>}
            </div>
        </div>
    );
};

const ProductListing = ({ sellerId, isVerified }) => {
    const { db, appId } = React.useContext(AppContext);
    const [product, setProduct] = useState({ name: '', stock: 10, mrp: 500, discount: 50, details: '', location: '', brand: '', warranty: '' });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [feedback, setFeedback] = useState('');

    const handleChange = (e) => {
        const { name, value } = e.target;
        setProduct(prev => ({ ...prev, [name]: name === 'stock' || name === 'mrp' || name === 'discount' ? Number(value) : value }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!isVerified) {
            setFeedback("Error: You must complete the verification process (Phase 1) first.");
            return;
        }

        setIsSubmitting(true);
        const newProductId = Date.now().toString();

        try {
            if (!auth.currentUser) {
                setFeedback('Error: User not authenticated. Cannot list product.');
                setIsSubmitting(false);
                return;
            }
            await setDoc(doc(db, `artifacts/${appId}/public/data/products`, newProductId), {
                id: newProductId,
                sellerId: sellerId,
                rating: 0,
                reviewCount: 0,
                ...product,
                createdAt: new Date(),
            });
            setFeedback(`Product "${product.name}" listed successfully!`);
            setProduct({ name: '', stock: 10, mrp: 500, discount: 50, details: '', location: '', brand: '', warranty: '' });
        } catch (e) {
            setFeedback('Error listing product: ' + e.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="p-6 bg-white rounded-xl shadow-2xl">
            <h2 className="text-2xl font-bold text-purple-700 mb-4">List New Product (AI-Auditing)</h2>
            <p className="text-sm text-gray-600 mb-4">
                *The system uses AI to audit images, price, and keywords before listing.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex space-x-4">
                    <input
                        name="name"
                        value={product.name}
                        onChange={handleChange}
                        placeholder="Product Name (e.g., Premium Saree)"
                        required
                        className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                    <input
                        name="brand"
                        value={product.brand}
                        onChange={handleChange}
                        placeholder="Brand"
                        required
                        className="w-1/3 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                </div>
                
                <div className="flex space-x-4">
                    <input
                        name="mrp"
                        type="number"
                        value={product.mrp}
                        onChange={handleChange}
                        placeholder="MRP"
                        required
                        className="w-1/3 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                    <input
                        name="discount"
                        type="number"
                        value={product.discount}
                        onChange={handleChange}
                        placeholder="Discount (%)"
                        required
                        className="w-1/3 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                    <input
                        name="stock"
                        type="number"
                        value={product.stock}
                        onChange={handleChange}
                        placeholder="Stock Quantity"
                        required
                        className="w-1/3 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                </div>
                <textarea
                    name="details"
                    value={product.details}
                    onChange={handleChange}
                    placeholder="Product Details (Keywords are audited by NLP)"
                    rows="3"
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                />
                <div className="flex space-x-4">
                    <input
                        name="location"
                        value={product.location}
                        onChange={handleChange}
                        placeholder="Stock Location (for Geospatial tracking)"
                        required
                        className="w-1/2 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                    <input
                        name="warranty"
                        value={product.warranty}
                        onChange={handleChange}
                        placeholder="Warranty (e.g., 1 Year)"
                        className="w-1/2 p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500"
                    />
                </div>
                
                <div className="p-3 bg-gray-100 rounded-lg">
                    <p className="text-sm text-center font-medium">Product Image / Stock Image Upload (Simulated)</p>
                    <input type="file" className="mt-1 text-sm text-gray-500" disabled={!isVerified} />
                </div>
                <button
                    type="submit"
                    disabled={isSubmitting || !isVerified}
                    className="w-full p-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition duration-150 disabled:bg-gray-400"
                >
                    {isSubmitting ? 'Listing...' : 'List Product'}
                </button>
                {feedback && <p className="mt-4 p-3 rounded-lg text-sm bg-blue-100 text-blue-700">{feedback}</p>}
                {!isVerified && <p className="mt-4 p-3 rounded-lg text-sm bg-red-100 text-red-700 font-bold">Verification Pending: Must complete KYC to list products.</p>}
            </form>
        </div>
    );
};

const SellerDashboard = () => {
    const { userId, sellers, products, orders } = React.useContext(AppContext);
    const currentSeller = sellers.find(s => s.id === userId);
    const sellerProducts = products.filter(p => p.sellerId === userId);
    const sellerOrders = orders.filter(o => o.sellerId === userId && o.status === 'Pending Shipment');

    const handleShipOrder = async (orderId) => {
        if (!db || !userId) return;
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/orders`, orderId), {
                status: 'Shipped',
                shippedAt: new Date(),
            });
            console.log(`Order ${orderId} marked as shipped.`);
        } catch (e) {
            console.error("Failed to ship order:", e);
        }
    };

    return (
        <div className="container mx-auto p-8 pt-24 bg-gray-50 min-h-screen">
            <h2 className="text-3xl font-extrabold text-gray-800 mb-6">Your Seller Dashboard (Phase 3)</h2>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                {/* Verification Status */}
                <div className="lg:col-span-1">
                    <SellerVerification sellerId={userId} currentSeller={currentSeller} />
                </div>

                {/* Trust Score Card */}
                <div className="bg-white p-6 rounded-xl shadow-2xl border-l-4 border-purple-500">
                    <h3 className="text-xl font-bold text-gray-700 mb-3">Algorithmic Trust Score</h3>
                    <div className="flex items-center justify-between">
                        <p className="text-5xl font-extrabold text-purple-700">
                            {currentSeller?.trustScore ?? 'N/A'}
                        </p>
                        <TrustPill status={currentSeller?.trustStatus || 'Pending'} color={currentSeller?.trustColor || 'bg-gray-300 text-gray-800'} />
                    </div>
                    <p className="mt-4 text-sm text-gray-500">
                        *Score updates automatically based on performance metrics (Manual trigger on review).
                    </p>
                </div>

                {/* Key Performance Metrics */}
                <div className="bg-white p-6 rounded-xl shadow-2xl border-l-4 border-green-500">
                    <h3 className="text-xl font-bold text-gray-700 mb-3">Operational Metrics</h3>
                    <div className="space-y-2 text-sm text-gray-600">
                        <p>Total Shipments: <span className="font-semibold text-gray-800">{currentSeller?.totalShipments ?? 0}</span></p>
                        <p>Successful Deliveries: <span className="font-semibold text-gray-800">{currentSeller?.successfulDeliveries ?? 0}</span></p>
                        <p>Success Rate: <span className="font-semibold text-green-600">
                            {currentSeller?.totalShipments > 0 ? `${((currentSeller.successfulDeliveries / currentSeller.totalShipments) * 100).toFixed(1)}%` : 'N/A'}
                        </span></p>
                        <p>Avg Payout Ratio: <span className="font-semibold text-gray-800">{((currentSeller?.payoutRatio || 0) * 100).toFixed(1)}%</span></p>
                        <p>Avg Resolution Time: <span className="font-semibold text-red-500">{currentSeller?.problemResolutionTime || '0'} hrs</span></p>
                    </div>
                </div>
            </div>
            
            {/* Pending Orders Section */}
            <h3 className="text-2xl font-bold text-red-600 mb-4 mt-8">Pending Orders ({sellerOrders.length})</h3>
            <div className="bg-white rounded-xl shadow-lg p-4">
                {sellerOrders.length > 0 ? (
                    <div className="space-y-4">
                        {sellerOrders.map(order => (
                            <div key={order.id} className="p-3 border-b border-gray-100 flex justify-between items-center bg-red-50 rounded-lg">
                                <div>
                                    <p className="font-semibold text-gray-800">{order.productName} (Qty: {order.quantity})</p>
                                    <p className="text-xs text-gray-500">To: {order.shippingAddress || 'Dummy Address'} | Order ID: {order.id.substring(0, 8)}</p>
                                </div>
                                <button
                                    onClick={() => handleShipOrder(order.id)}
                                    className="bg-purple-600 text-white text-xs px-3 py-1 rounded-full hover:bg-purple-700"
                                >
                                    Mark as Shipped
                                </button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-gray-500 text-center py-4">No pending orders to ship.</p>
                )}
            </div>

            {/* Product Listing Form */}
            <div className="my-8">
                <ProductListing sellerId={userId} isVerified={!!currentSeller} />
            </div>

            {/* Seller Products List */}
            <h3 className="text-2xl font-bold text-gray-800 mb-4">Your Active Listings ({sellerProducts.length})</h3>
            <div className="bg-white rounded-xl shadow-lg p-4">
                {sellerProducts.length > 0 ? (
                    <div className="space-y-4">
                        {sellerProducts.map(product => (
                            <div key={product.id} className="p-3 border-b border-gray-100 flex justify-between items-center">
                                <div>
                                    <p className="font-semibold text-purple-600">{product.name} ({product.brand})</p>
                                    <p className="text-xs text-gray-500">Stock: {product.stock} | Warranty: {product.warranty}</p>
                                </div>
                                <div className="text-sm">Rating: <span className="font-bold text-yellow-600">{product.rating ? `${product.rating.toFixed(1)} / 5` : 'N/A'}</span></div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-gray-500 text-center py-4">No products listed yet.</p>
                )}
            </div>
        </div>
    );
};

// --- CUSTOMER COMPONENTS ---

const ReviewAndComplaintForm = ({ productId, sellerId, currentSeller }) => {
    const { db, appId, userId, updateSellerScore } = React.useContext(AppContext);
    const [rating, setRating] = useState(5);
    const [reviewText, setReviewText] = useState('');
    const [complaintText, setComplaintText] = useState('');
    const [feedback, setFeedback] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleReviewSubmit = async (e) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            if (!auth.currentUser) {
                setFeedback('Error: User not authenticated. Cannot submit review.');
                setIsSubmitting(false);
                return;
            }
            
            // Add new review
            const reviewId = userId + "_" + Date.now().toString();
            await setDoc(doc(db, `artifacts/${appId}/public/data/reviews`, reviewId), {
                id: reviewId,
                productId: productId,
                sellerId: sellerId,
                customerId: userId,
                rating: rating,
                text: reviewText,
                timestamp: new Date(),
            });

            setFeedback('Review submitted successfully! Triggering Trust Score update...');
            setReviewText('');
            setComplaintText('');
            
            // Trigger score update immediately after submitting review
            updateSellerScore(sellerId);

        } catch (e) {
            setFeedback('Error submitting review: ' + e.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleComplaintSubmit = async () => {
        if (!auth.currentUser) {
            setFeedback('Error: User not authenticated. Cannot file complaint.');
            return;
        }

        try {
            // Add new complaint
            const complaintId = userId + "_comp_" + Date.now().toString();
            await setDoc(doc(db, `artifacts/${appId}/public/data/complaints`, complaintId), {
                id: complaintId,
                productId: productId,
                sellerId: sellerId,
                customerId: userId,
                reason: complaintText,
                timestamp: new Date(),
            });

            setFeedback(`Complaint submitted! Triggering Trust Score audit...`);
            setComplaintText('');
            
            // Trigger score update immediately after submitting complaint
            updateSellerScore(sellerId);
        } catch (e) {
            setFeedback('Error submitting complaint: ' + e.message);
        }
    };

    return (
        <div className="p-6 bg-white rounded-xl shadow-2xl space-y-6">
            <h3 className="text-xl font-bold text-gray-800">Submit Feedback & Complaint</h3>
            
            {/* Review Form */}
            <form onSubmit={handleReviewSubmit} className="space-y-4 p-4 border border-yellow-200 rounded-lg">
                <p className="font-medium text-purple-700">1. Rate and Review Product/Seller</p>
                <div className="flex items-center space-x-2">
                    <label className="font-medium">Rating (1-5):</label>
                    <input
                        type="number"
                        min="1" max="5"
                        value={rating}
                        onChange={(e) => setRating(Number(e.target.value))}
                        className="p-2 border border-gray-300 rounded-lg w-20"
                    />
                </div>
                <textarea
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                    placeholder="Write your review here (This will influence the Seller's Trust Score)"
                    rows="2"
                    className="w-full p-3 border border-gray-300 rounded-lg"
                    required
                />
                <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full p-2 bg-yellow-500 text-white rounded-lg font-semibold hover:bg-yellow-600 transition duration-150"
                >
                    Submit Review & Rating
                </button>
            </form>

            {/* Complaint Form */}
            <div className="space-y-4 p-4 border border-red-300 rounded-lg">
                <p className="font-medium text-red-700">2. File a Complaint (Triggers Al Audit)</p>
                <textarea
                    value={complaintText}
                    onChange={(e) => setComplaintText(e.target.value)}
                    placeholder="Describe the problem (e.g., Wrong item received, delivery agent scam, quality issue). This triggers Phase 2 analysis."
                    rows="2"
                    className="w-full p-3 border border-gray-300 rounded-lg"
                    required
                />
                <button
                    onClick={handleComplaintSubmit}
                    disabled={isSubmitting || !complaintText}
                    className="w-full p-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition duration-150"
                >
                    File Complaint (High Risk Flag)
                </button>
            </div>

            {feedback && <p className="mt-4 p-3 rounded-lg text-sm bg-green-100 text-green-700">{feedback}</p>}
        </div>
    );
};

const CustomerDashboard = () => {
    const { products, sellers, reviews, orders, userId, db, appId } = React.useContext(AppContext);

    // Filter products not yet purchased by this user (to keep the list dynamic)
    const productsToDisplay = products.filter(p => !orders.some(o => o.productId === p.id && o.customerId === userId));
    const featuredProduct = productsToDisplay[0] || products[0] || { id: 'dummy', sellerId: 'N/A', name: 'Demo Product', mrp: 1000, discount: 20, stock: 5, details: 'Example product for testing.' };
    const featuredSeller = sellers.find(s => s.id === featuredProduct.sellerId);

    // Initial dummy data only runs once when collections are empty
    useEffect(() => {
        if (!db || !auth.currentUser) return; // Ensure Auth and DB are ready

        const addDummyData = async () => {
            const sellersCol = collection(db, `artifacts/${appId}/public/data/sellers`);
            
            // Check if sellers collection is empty (no need to check products if sellers are empty)
            const sellersSnapshot = await getDocs(query(sellersCol));
            
            if (sellersSnapshot.empty) {
                console.log("Adding initial dummy data...");
                const dummySellerId = 'seller_1';
                const dummyProductId = 'prod_1';

                // Use runTransaction to ensure atomicity for initial data setup
                await runTransaction(db, async (transaction) => {
                    const sellerDocRef = doc(db, `artifacts/${appId}/public/data/sellers`, dummySellerId);
                    const productDocRef = doc(db, `artifacts/${appId}/public/data/products`, dummyProductId);
                    
                    transaction.set(sellerDocRef, {
                        id: dummySellerId,
                        name: 'The Mega Mart (Verified)',
                        email: 'demo@meesho.com',
                        pan: 'DEMOPAN123',
                        gst: 'DEMOGST456',
                        trustScore: 92,
                        trustStatus: 'Verified',
                        trustColor: 'bg-green-600 text-white font-bold',
                        totalShipments: 500, // FIXED: High shipment count to bypass 'Newcomer' status
                        successfulDeliveries: 495,
                        isFlagged: false,
                        problemResolutionTime: 6,
                        stockToOrderRatio: 0.95,
                        payoutRatio: 0.9,
                        createdAt: new Date(),
                    });

                    transaction.set(productDocRef, {
                        id: dummyProductId,
                        sellerId: dummySellerId,
                        name: 'Trendy Designer Kurti',
                        brand: 'DesiWear',
                        stock: 50,
                        mrp: 1299,
                        discount: 30,
                        details: 'High-quality cotton blend material, perfect for daily wear.',
                        location: 'Surat, GJ',
                        warranty: '30 Days',
                        rating: 4.8,
                        reviewCount: 45,
                        createdAt: new Date(),
                    });
                });
            }
        };
        
        if (auth.currentUser) {
            addDummyData();
        }
    }, [db, auth, appId]);

    const handlePurchase = async (product) => {
        if (!db || !userId) return;
        try {
            await setDoc(doc(db, `artifacts/${appId}/public/data/orders`, Date.now().toString()), {
                customerId: userId,
                sellerId: product.sellerId,
                productId: product.id,
                productName: product.name,
                quantity: 1, // Simplified
                totalPrice: product.mrp * (1 - product.discount / 100),
                shippingAddress: 'A4, South Mumbai, 400001', // Dummy address
                status: 'Pending Shipment',
                orderedAt: new Date(),
            });
            // Update successful deliveries on seller side immediately to reflect score change potential
            await updateDoc(doc(db, `artifacts/${appId}/public/data/sellers`, product.sellerId), {
                totalShipments: (featuredSeller?.totalShipments || 0) + 1,
            });
            alert(`Purchase successful! Your order for ${product.name} is now pending shipment.`);
        } catch (e) {
            alert("Purchase failed. See console for details.");
            console.error(e);
        }
    };

    return (
        <div className="container mx-auto p-8 pt-24 bg-gray-50 min-h-screen">
            <h2 className="text-3xl font-extrabold text-purple-700 mb-6">Meesho Marketplace</h2>

            {/* Current Orders View (Simplified) */}
            <h3 className="text-2xl font-bold text-gray-800 mb-4 border-b pb-2">Your Orders ({orders.length})</h3>
            <div className="mb-8 bg-white rounded-xl shadow-lg p-4 space-y-3">
                {orders.length > 0 ? (
                    orders.map(order => (
                        <div key={order.id} className={`p-3 rounded-lg flex justify-between items-center ${order.status === 'Shipped' ? 'bg-green-100' : 'bg-yellow-100'}`}>
                            <div>
                                <p className="font-semibold text-gray-800">{order.productName} (Qty: {order.quantity})</p>
                                <p className="text-sm text-gray-600">Status: <span className="font-bold">{order.status}</span></p>
                            </div>
                            <button
                                onClick={() => alert(`Tracking details for Order ${order.id.substring(0, 8)}: Estimated Delivery 3 days.`)}
                                className="bg-purple-500 text-white text-xs px-3 py-1 rounded-full hover:bg-purple-600"
                            >
                                Track Order
                            </button>
                        </div>
                    ))
                ) : (
                    <p className="text-gray-500 text-center py-2">You have no active orders.</p>
                )}
            </div>

            {/* Product Catalog */}
            <h3 className="text-2xl font-bold text-gray-800 mb-4 border-t pt-6">Products Available ({productsToDisplay.length})</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {productsToDisplay.length > 0 ? (
                    productsToDisplay.map(product => (
                        <div key={product.id}>
                            <ProductCard product={product} />
                            <button
                                onClick={() => handlePurchase(product)}
                                className="mt-2 w-full p-2 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 transition duration-150"
                            >
                                Buy Now (Simulated)
                            </button>
                        </div>
                    ))
                ) : (
                    <p className="col-span-4 text-center text-gray-500 py-10">No products available.</p>
                )}
            </div>

            {/* Featured Product for Review/Complaint */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12 mt-12 border-t pt-8">
                <div className="lg:col-span-2 space-y-6">
                    <h3 className="text-2xl font-bold text-gray-800">Featured Product for Review (Post-Delivery Simulation)</h3>
                    <ProductCard product={featuredProduct} />
                    <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-yellow-500">
                        <h4 className="text-xl font-bold text-gray-800 mb-3">Seller Profile: {featuredSeller?.name || 'N/A'}</h4>
                        <div className="space-y-3">
                            <p className="text-sm font-medium">Verification Status: <TrustPill status={featuredSeller?.trustStatus || 'N/A'} color={featuredSeller?.trustColor || 'bg-gray-300 text-gray-800'} /></p>
                            <p className="text-sm">Trust Score: <span className="font-bold text-purple-700 text-lg">{featuredSeller?.trustScore ?? 'N/A'}</span></p>
                            
                            <h5 className="text-md font-semibold mt-4 border-t pt-3">Customer Reviews</h5>
                            {reviews.filter(r => r.sellerId === featuredProduct.sellerId).map(review => (
                                <div key={review.id} className="p-2 border-b last:border-b-0">
                                    <StarRating rating={review.rating} count={0} />
                                    <p className="text-sm text-gray-700 italic">"{review.text}"</p>
                                    <p className="text-xs text-gray-400 mt-1">by User {review.customerId.substring(0, 4)}...</p>
                                </div>
                            ))}
                            {reviews.filter(r => r.sellerId === featuredProduct.sellerId).length === 0 && <p className="text-sm text-gray-500">No recent seller reviews.</p>}
                        </div>
                    </div>
                </div>
                <div className="lg:col-span-1">
                    <ReviewAndComplaintForm productId={featuredProduct.id} sellerId={featuredProduct.sellerId} currentSeller={featuredSeller} />
                </div>
            </div>
        </div>
    );
};
