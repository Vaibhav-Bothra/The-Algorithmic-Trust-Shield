# 🛡️ Meesho Trust-Shield Prototype

This repository contains the code for a prototype e-commerce marketplace focusing on seller trustworthiness, built using **React** and **Firebase/Firestore**. The core innovation is the implementation of a proprietary **Algorithmic Trust Score** (A-TS) that dynamically evaluates sellers based on multiple transactional and behavioral metrics.

## 🌟 Key Features

* **Dual Interface:** Separate views for **Customers** (product listing, purchasing, review/complaint submission) and **Sellers** (onboarding, product listing, order fulfillment).
* **Trust Score Algorithm (A-TS):** A composite score (0-100) calculated from multiple weighted parameters, providing a real-time risk assessment of the seller.
* **Seller Verification Workflow:** A simulated KYC process including email/mobile OTP and document submission (PAN/GST) with checks for blacklisted/flagged entities.
* **Transactional Feedback Loop:** Customer reviews and complaints directly trigger a score audit, demonstrating the immediate impact of user feedback on seller reputation.
* **Order Tracking:** Simple order flow from "Pending Shipment" (Seller view) to customer feedback actions.

***

## 💻 Technical Stack

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Frontend** | **React** (Hooks, Context API) | Interactive user interface, state management, and view routing. |
| **Styling** | **Tailwind CSS** | Utility-first styling for a clean, responsive layout. |
| **Backend/Database**| **Firebase Firestore** | Real-time, NoSQL database for product, seller, order, review, and complaint data. |
| **Authentication** | **Firebase Auth** | Simple anonymous sign-in to assign unique `userId` (Guest/Customer/Seller ID) for transactional tracking. |
| **Logic Core** | **JavaScript/React Hooks** | Houses the complex `calculateTrustScore` function and transaction logic. |

***

## 💡 Trust Score Algorithm (A-TS) Explained

The Trust Score is calculated upon specific triggers (e.g., a new review, complaint, or a significant change in operational metrics). It is based on a simulated weighted model:

$$A-TS = \text{Base Score} + \sum (\text{Weighted Impacts}) - \sum (\text{Penalties})$$

| Parameter | Weight/Impact | Function in Score | Trigger |
| :--- | :--- | :--- | :--- |
| **Customer Ratings** | High | Rewards/Penalizes deviation from a 4.0 average. | New Review/Rating submission. |
| **Delivery Success Rate** | Medium | Rewards success above 95%; penalizes failures/returns. | Order placement and simulated fulfillment. |
| **Complaints Filed** | High Penalty | Heavy deduction for each valid complaint. | Customer files a complaint. |
| **Payout/Risk Ratio** | Low | Rewards sellers with reliable financial histories. | Periodic simulation (Internal metric). |
| **Hard Flags** | Instant Fail | Overrides calculation if KYC fails (e.g., `FLAGGEDPAN`). | Seller Onboarding. |

***

## ⚙️ Project Setup and Installation

Since this is a single file simulation for a complex MERN/Firebase application, the setup steps are focused on adapting a typical React project to use the provided code.

### Prerequisites

1.  Node.js and npm installed.
2.  A basic React project environment (e.g., created via Create React App or Vite).

### Installation Steps (For Local Environment)

1.  **Clone the Repository:** (Assume this README is part of a repository).
    ```bash
    git clone [your-repo-url]
    cd [repo-name]
    ```

2.  **Replace Frontend Code:** Replace the content of your main application file (e.g., `src/App.jsx` or `src/App.js`) with the provided React code.

3.  **Firebase Setup (Crucial):**
    * Create a new project in the Firebase Console.
    * Enable **Firestore Database** and **Anonymous Authentication**.
    * Get your Firebase configuration object.
    * The provided code uses mocked global variables (`__app_id`, `__firebase_config`). To run this against a real Firebase project, you must replace the placeholder configuration logic at the top of the file:
        ```javascript
        // Original placeholder:
        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
        
        // Replace with your actual config object:
        const firebaseConfig = {
            apiKey: "YOUR_API_KEY",
            authDomain: "YOUR_AUTH_DOMAIN",
            projectId: "YOUR_PROJECT_ID", // Important for Firestore paths
            // ...other settings
        };
        ```

4.  **Install React Dependencies (if not already installed):**
    ```bash
    npm install firebase react react-dom
    ```

5.  **Run the Application:**
    ```bash
    npm start  # (or 'npm run dev' if using Vite)
    ```

***

## 🚀 How to Interact with the Prototype

Use the **Switch View** button in the top right corner to toggle between the two main user roles.

### A. Customer Workflow

1.  **View Products:** See product listings, each displaying the seller's current **Trust Status** and Score.
2.  **Purchase:** Click **"Buy Now (Simulated)"**. This instantly records an order in the mock database and **increments the seller's total shipments** metric.
3.  **Submit Feedback:** Use the **Review and Complaint Form** section (at the bottom of the page).
    * **Submit Review:** Rate the product/seller (1-5) and provide text. This immediately calls `updateSellerScore`, rewarding good performance.
    * **File Complaint:** Use the complaint box. This applies a **heavy penalty** to the seller's Trust Score, reflecting a high-risk transaction.

### B. Seller Workflow

1.  **Onboarding (First Visit):** If you are a new ID (not `seller_1`), you must first complete the verification steps.
    * Use any text for email/PAN/GST.
    * Use **`123456`** for the OTP.
    * **Test the Vetting:** To see the system flag a seller, use **`FLAGGEDPAN`** as the PAN number during submission. This results in a hard score fail (`Trust Score: 1`).
2.  **Dashboard View:**
    * Check the **Algorithmic Trust Score** card to see the score and its division (Verified, Standard, Flagged).
    * Monitor the **Operational Metrics** (Shipments, Success Rate, Payout Ratio).
    * List a new product using the **Product Listing** form (only enabled after verification).
    * View **Pending Orders** placed by the customer.

***

## 🛑 Limitations and Mocked Behavior

* **No Real Payments/Cart:** The "Buy Now" button only simulates the order creation in Firestore and stock deduction; there is no actual payment processing or cart interface.
* **Mocked Database:** The application uses Firebase's real-time listeners, but the initial data and updates rely on mocked functions and an in-memory database (`mockDb`) for transactional continuity.
* **Simplified Metrics:** Metrics like `successfulDeliveries` are incremented based on simple client-side logic or random chance, not a complex external logistics system.
* **Static Review Update:** The A-TS is intentionally set to update immediately upon a customer review/complaint submission to demonstrate the scoring impact, bypassing any potential backend queues or scheduled jobs.
