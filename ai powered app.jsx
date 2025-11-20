import React, { useState, useCallback, useEffect } from 'react';

// --- Firebae/Auth/Firestore Imports ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, limit, getDocs } from 'firebase/firestore';

// Define global variables provided by the environment
// NOTE: These variables are automatically injected by the deployment environment (e.g., Canvas).
// They allow the app to use Firebase for saving history without requiring the user to set up their own paid database.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-ai-app';
const apiKey = ""; // API Key for Gemini API (Leave empty for the platform to handle)

// Helper function for exponential backoff (for API retries)
const withExponentialBackoff = async (fn, retries = 5, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

// Main App Component
const App = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    const [nicheInput, setNicheInput] = useState('');
    const [ideas, setIdeas] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [history, setHistory] = useState([]);
    
    // --- Global Style Injection ---
    // This injects Tailwind CSS and the custom font once when the component mounts.
    useEffect(() => {
        // 1. Load Tailwind CSS (if not already loaded)
        if (!document.querySelector('script[src*="cdn.tailwindcss.com"]')) {
            const tailwindScript = document.createElement('script');
            tailwindScript.src = "https://cdn.tailwindcss.com";
            document.head.appendChild(tailwindScript);
        }

        // 2. Load Inter Font
        if (!document.querySelector('link[href*="Inter"]')) {
            const fontLink = document.createElement('link');
            fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap";
            fontLink.rel = "stylesheet";
            document.head.appendChild(fontLink);
        }

        // 3. Apply global body font style
        if (!document.getElementById('global-font-style')) {
            const style = document.createElement('style');
            style.id = 'global-font-style';
            style.textContent = `body { font-family: 'Inter', sans-serif; }`;
            document.head.appendChild(style);
        }
    }, []);

    // --- 1. Firebase Initialization and Authentication ---
    useEffect(() => {
        if (!firebaseConfig) {
            console.error("Firebase config not available. Running in local mode.");
            setIsAuthReady(true);
            return;
        }

        const app = initializeApp(firebaseConfig);
        const firestoreDb = getFirestore(app);
        const firebaseAuth = getAuth(app);
        
        setDb(firestoreDb);
        setAuth(firebaseAuth);

        const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
            if (!user) {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                } catch (e) {
                    console.error("Error signing in:", e);
                }
            }
            // Ensure userId is set after auth check
            setUserId(firebaseAuth.currentUser?.uid || crypto.randomUUID());
            setIsAuthReady(true);
        });

        return () => unsubscribe();
    }, []);

    // Firestore paths
    const getHistoryCollectionRef = useCallback(() => {
        if (db && userId) {
            // Private data path for saving user history
            return collection(db, 'artifacts', appId, 'users', userId, 'ideas');
        }
        return null;
    }, [db, userId]);

    // --- 2. History Fetching ---
    const fetchHistory = useCallback(async () => {
        const historyRef = getHistoryCollectionRef();
        if (!isAuthReady || !historyRef) return;
        
        try {
            // Fetch last 5 ideas
            const q = query(historyRef, limit(5)); 
            const querySnapshot = await getDocs(q);
            const loadedHistory = querySnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })).sort((a, b) => b.timestamp - a.timestamp); // Sort by newest first
            setHistory(loadedHistory);
        } catch (e) {
            console.error("Error fetching history:", e);
        }
    }, [isAuthReady, getHistoryCollectionRef]);

    useEffect(() => {
        // Prevent running before auth is ready
        if (isAuthReady) {
            fetchHistory();
        }
    }, [isAuthReady, fetchHistory]);

    // --- 3. Gemini API Call and Persistence ---
    const handleGenerateIdeas = async () => {
        if (!nicheInput.trim()) {
            setError("Please enter a niche or audience to generate ideas.");
            return;
        }
        if (!isAuthReady) {
            setError("Authentication not ready. Please wait a moment.");
            return;
        }

        setError(null);
        setIdeas('');
        setIsLoading(true);

        // Enhanced prompt for a high-demand business tool
        const userPrompt = `Generate 3 high-demand, low-startup-cost online product or service ideas for the niche: "${nicheInput}". 
        For each idea, provide:
        1. A compelling Product Name.
        2. A concise One-sentence Description.
        3. A suggested Target Audience.
        4. Three effective Marketing Angle bullet points.
        Present the ideas clearly and professionally.`;
        
        const payload = {
            contents: [{ parts: [{ text: userPrompt }] }],
            tools: [{ "google_search": {} }], 
            systemInstruction: {
                parts: [{ text: "You are a world-class business development AI. Your response must be structured, professional, and contain actionable, innovative ideas without any introductory or concluding conversation." }]
            }
        };

        try {
            const result = await withExponentialBackoff(async () => {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (!response.ok) {
                    const errorBody = await response.json();
                    throw new Error(`API call failed: ${response.status} ${response.statusText}. Details: ${errorBody.error?.message || 'No details provided.'}`);
                }

                return await response.json();
            });

            const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text || 'Idea generation failed.';
            setIdeas(generatedText);

            // --- Save to Firestore ---
            const historyRef = getHistoryCollectionRef();
            if (historyRef) {
                await setDoc(doc(historyRef, crypto.randomUUID()), {
                    niche: nicheInput,
                    generatedIdeas: generatedText,
                    timestamp: Date.now()
                });
                fetchHistory(); // Refresh history
            } else {
                 console.warn("Firestore history not saved: DB or User ID not available.");
            }

        } catch (e) {
            console.error("Gemini API Error:", e);
            setError(e.message.includes('API call failed') ? e.message : 'An unknown error occurred during idea generation.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center p-4">
            
            <div className="w-full max-w-4xl bg-white rounded-xl shadow-2xl p-6 md:p-10 mt-8">
                <header className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800">AI Business Idea Generator</h1>
                    <p className="text-gray-500 mt-2 font-medium">Generate high-demand, low-cost startup ideas for any niche.</p>
                    <p className="text-xs text-gray-400 mt-1">User ID: <span className="font-mono">{userId || 'Loading...'}</span> | App ID: <span className="font-mono">{appId}</span></p>
                </header>

                {/* Input Area */}
                <div className="mb-8">
                    <label htmlFor="nicheInput" className="block text-sm font-medium text-gray-700 mb-2">
                        Enter Your Niche or Target Audience (e.g., "Remote dog owners", "Freelance photographers", "DIY home renovators")
                    </label>
                    <textarea
                        id="nicheInput"
                        rows="4"
                        className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 transition duration-150 ease-in-out resize-none"
                        placeholder="e.g., Small business owners needing social media content."
                        value={nicheInput}
                        onChange={(e) => setNicheInput(e.target.value)}
                        disabled={isLoading}
                    />
                    <button
                        onClick={handleGenerateIdeas}
                        disabled={isLoading || !isAuthReady}
                        className={`w-full mt-4 px-6 py-3 rounded-xl text-white font-semibold transition duration-200 ease-in-out transform hover:scale-[1.01] shadow-lg
                            ${isLoading || !isAuthReady 
                                ? 'bg-gray-400 cursor-not-allowed' 
                                : 'bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-4 focus:ring-purple-500 focus:ring-opacity-50'
                            }`}
                    >
                        {isLoading ? (
                            <div className="flex items-center justify-center">
                                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Generating Ideas...
                            </div>
                        ) : 'Generate High-Demand Ideas'}
                    </button>
                    {error && (
                        <div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg">
                            Error: {error}
                        </div>
                    )}
                </div>

                {/* Output Area */}
                {ideas && (
                    <div className="mb-8">
                        <h2 className="text-xl font-semibold text-gray-800 mb-3">Startup Concepts</h2>
                        <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg shadow-inner whitespace-pre-wrap">
                            {ideas}
                        </div>
                    </div>
                )}

                {/* History Section */}
                {history.length > 0 && (
                    <div className="mt-10">
                        <h2 className="text-xl font-semibold text-gray-800 mb-4">Recent Niche Ideas (Saved to Firestore)</h2>
                        <div className="space-y-4">
                            {history.map((item, index) => (
                                <details key={item.id} className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 cursor-pointer hover:bg-gray-50 transition duration-150">
                                    <summary className="font-medium text-gray-700 flex justify-between items-center">
                                        Ideas for "{item.niche.substring(0, 50)}..."
                                        <span className="text-sm text-gray-500">
                                            {new Date(item.timestamp).toLocaleDateString()}
                                        </span>
                                    </summary>
                                    <div className="mt-3 text-sm text-gray-600">
                                        <h4 className="font-semibold mt-2">Generated Output Snippet:</h4>
                                        <p className="italic border-l-2 border-gray-300 pl-2 max-h-20 overflow-hidden">
                                            {item.generatedIdeas.substring(0, 150)}...
                                        </p>
                                    </div>
                                </details>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default App;