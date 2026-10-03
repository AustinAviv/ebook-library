// Supabase Bridge for Aviv Library (Blazor WASM)
(function () {
    const STORAGE_BUCKET = "book-submissions";
    let supabaseClient = null;
    let configuredUrl = "";
    let configuredKey = "";

    function getClient() {
        if (!supabaseClient) {
            if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
                console.error("[SupabaseBridge] Supabase library is not loaded.");
                return null;
            }
            if (!configuredUrl || !configuredKey) {
                console.warn("[SupabaseBridge] Supabase not initialized with URL and Key.");
                return null;
            }
            supabaseClient = window.supabase.createClient(configuredUrl, configuredKey, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true,
                    storage: window.localStorage
                }
            });
        }
        return supabaseClient;
    }

    window.supabaseInit = function (url, anonKey) {
        if (typeof window.supabase === "undefined" || !window.supabase.createClient) {
            return false;
        }
        configuredUrl = (url || "").trim();
        configuredKey = (anonKey || "").trim();
        if (!configuredUrl || !configuredKey) return false;

        supabaseClient = window.supabase.createClient(configuredUrl, configuredKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
                storage: window.localStorage
            }
        });

        // Listen for session changes to keep localStorage sync bulletproof
        try {
            supabaseClient.auth.onAuthStateChange(async (event, session) => {
                if (session && session.user) {
                    try {
                        const r = await getUserRole(session.user.id);
                        localStorage.setItem("aviv_user_session", JSON.stringify({
                            id: session.user.id,
                            email: session.user.email,
                            role: r
                        }));
                    } catch { }
                } else if (event === "SIGNED_OUT") {
                    try {
                        localStorage.removeItem("aviv_user_session");
                    } catch { }
                }
            });
        } catch { }

        return true;
    };

    // Helper: fetch user role from database table user_roles
    async function getUserRole(userId) {
        if (!userId) return "user";
        try {
            const client = getClient();
            if (!client) return "user";
            const { data, error } = await client
                .from("user_roles")
                .select("role")
                .eq("user_id", userId)
                .maybeSingle();

            if (error || !data) return "user";
            return data.role || "user";
        } catch {
            return "user";
        }
    }

    // Auth methods
    window.supabaseAuthSignUp = async function (email, password) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        try {
            const { data, error } = await client.auth.signUp({
                email: email.trim(),
                password: password
            });
            if (error) {
                let msg = error.message;
                if (msg.toLowerCase().includes("signups not allowed")) {
                    msg = "Signups are disabled in your Supabase project (under Authentication > Providers > Email). Please use Sign In with your existing account.";
                }
                return JSON.stringify({ success: false, error: msg });
            }
            let role = "user";
            if (data && data.user) {
                role = await getUserRole(data.user.id);
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify({ id: data.user.id, email: data.user.email, role: role }));
                } catch { }
            }
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email, role: role } : null,
                session: data.session ? true : false
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    window.supabaseAuthSignIn = async function (email, password) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        try {
            const { data, error } = await client.auth.signInWithPassword({
                email: email.trim(),
                password: password
            });
            if (error) return JSON.stringify({ success: false, error: error.message });
            let role = "user";
            if (data && data.user) {
                role = await getUserRole(data.user.id);
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify({ id: data.user.id, email: data.user.email, role: role }));
                } catch { }
            }
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email, role: role } : null
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    window.supabaseAuthSignOut = async function () {
        try {
            localStorage.removeItem("aviv_user_session");
        } catch { }
        const client = getClient();
        if (!client) return true;
        try {
            await client.auth.signOut();
            return true;
        } catch (err) {
            console.warn("[SupabaseBridge] SignOut error:", err);
            return false;
        }
    };

    window.supabaseAuthGetUser = async function () {
        const client = getClient();
        if (!client) {
            // Check fallback cache while client initializes
            try {
                const cached = localStorage.getItem("aviv_user_session");
                if (cached) return cached;
            } catch { }
            return null;
        }

        try {
            // 1. Check getSession first (fastest, reads from localStorage without network roundtrip)
            const { data: sessionData } = await client.auth.getSession();
            if (sessionData && sessionData.session && sessionData.session.user) {
                const user = sessionData.session.user;
                const role = await getUserRole(user.id);
                const u = {
                    id: user.id,
                    email: user.email,
                    role: role
                };
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify(u));
                } catch { }
                return JSON.stringify(u);
            }

            // 2. Network verification
            const { data, error } = await client.auth.getUser();
            if (!error && data && data.user) {
                const user = data.user;
                const role = await getUserRole(user.id);
                const u = {
                    id: user.id,
                    email: user.email,
                    role: role
                };
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify(u));
                } catch { }
                return JSON.stringify(u);
            }

            // 3. Fallback to cached session
            try {
                return localStorage.getItem("aviv_user_session");
            } catch { }
            return null;
        } catch {
            try {
                return localStorage.getItem("aviv_user_session");
            } catch { }
            return null;
        }
    };

    // Direct Browser-to-Supabase Storage Upload
    window.supabaseUploadBookFile = async function (inputId, sanitizedFileName) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });

        const inputEl = document.getElementById(inputId);
        if (!inputEl || !inputEl.files || inputEl.files.length === 0) {
            return JSON.stringify({ success: false, error: "No PDF file selected." });
        }

        const file = inputEl.files[0];
        if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
            return JSON.stringify({ success: false, error: "Selected file must be a PDF document (.pdf)." });
        }

        // 50 MB limit
        const maxBytes = 50 * 1024 * 1024;
        if (file.size > maxBytes) {
            return JSON.stringify({ success: false, error: "File exceeds 50 MB maximum limit." });
        }

        // Clean up filename and strip any C:\fakepath\ or directories
        const rawName = sanitizedFileName || file.name || "book.pdf";
        const baseName = rawName.split(/[\\/]/).pop() || "book.pdf";
        const cleanName = baseName
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, "_");
        const uniquePath = `uploads/${Date.now()}_${cleanName}`;

        try {
            const { data, error } = await client.storage
                .from(STORAGE_BUCKET)
                .upload(uniquePath, file, {
                    cacheControl: "31536000",
                    upsert: true,
                    contentType: "application/pdf"
                });

            if (error) {
                console.error("[SupabaseBridge] Storage upload error:", error);
                let userMsg = error.message;
                if (userMsg.toLowerCase().includes("bucket not found") || userMsg.toLowerCase().includes("bucket")) {
                    userMsg = "Storage bucket 'book-submissions' not found. Please run supabase-setup.sql in your Supabase SQL Editor.";
                } else if (userMsg.toLowerCase().includes("row-level security")) {
                    userMsg = "Storage upload permission denied. Please run supabase-setup.sql in your Supabase SQL Editor.";
                }
                return JSON.stringify({ success: false, error: userMsg });
            }

            const { data: publicData } = client.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(uniquePath);

            return JSON.stringify({
                success: true,
                filePath: uniquePath,
                publicUrl: publicData ? publicData.publicUrl : "",
                fileSize: file.size
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Delete PDF from Supabase Storage (frees storage space upon rejection)
    window.supabaseDeleteBookFile = async function (filePath) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        if (!filePath || filePath.trim().length === 0) return JSON.stringify({ success: true });

        try {
            console.log(`[SupabaseBridge] Deleting storage file to save space: ${filePath}`);
            const { data, error } = await client.storage
                .from(STORAGE_BUCKET)
                .remove([filePath.trim()]);

            if (error) {
                console.warn("[SupabaseBridge] Storage removal error:", error);
                return JSON.stringify({ success: false, error: error.message });
            }

            console.log(`[SupabaseBridge] Storage file deleted successfully: ${filePath}`);
            return JSON.stringify({ success: true });
        } catch (err) {
            console.warn("[SupabaseBridge] Exception removing storage file:", err);
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Database: Submissions
    window.supabaseCreateSubmission = async function (payloadJson) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });

        try {
            const payload = JSON.parse(payloadJson);

            // Attempt insert with .select() to get generated database row
            const insertResult = await client
                .from("book_submissions")
                .insert([payload])
                .select();

            if (insertResult.error) {
                console.warn("[SupabaseBridge] Insert with select returned:", insertResult.error.message, "Retrying with standard insert...");
                // Resilient fallback: If SELECT is blocked by RLS for guest users, execute standard insert
                const fallbackResult = await client
                    .from("book_submissions")
                    .insert([payload]);

                if (fallbackResult.error) {
                    return JSON.stringify({ success: false, error: fallbackResult.error.message });
                }

                return JSON.stringify({
                    success: true,
                    submission: payload
                });
            }

            return JSON.stringify({
                success: true,
                submission: insertResult.data && insertResult.data.length > 0 ? insertResult.data[0] : payload
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    window.supabaseGetSubmissions = async function (statusFilter) {
        const client = getClient();
        if (!client) return JSON.stringify([]);

        try {
            let query = client
                .from("book_submissions")
                .select("*")
                .order("created_at", { ascending: false });

            if (statusFilter && statusFilter !== "all") {
                query = query.eq("status", statusFilter);
            }

            const { data, error } = await query;
            if (error) {
                console.error("[SupabaseBridge] Error fetching submissions:", error);
                return JSON.stringify([]);
            }
            return JSON.stringify(data || []);
        } catch (err) {
            console.error("[SupabaseBridge] Exception in getSubmissions:", err);
            return JSON.stringify([]);
        }
    };

    window.supabaseGetUserSubmissions = async function (userEmail) {
        const client = getClient();
        if (!client) return JSON.stringify([]);

        try {
            let query = client
                .from("book_submissions")
                .select("*")
                .order("created_at", { ascending: false });

            if (userEmail && userEmail.trim().length > 0) {
                query = query.ilike("submitter_email", userEmail.trim());
            }

            const { data, error } = await query;
            if (error) {
                console.error("[SupabaseBridge] Error fetching user submissions:", error);
                return JSON.stringify([]);
            }
            return JSON.stringify(data || []);
        } catch (err) {
            console.error("[SupabaseBridge] Exception in getUserSubmissions:", err);
            return JSON.stringify([]);
        }
    };

    window.supabaseUpdateSubmissionStatus = async function (id, newStatus, rejectionReason, filePath) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });

        try {
            const updatePayload = {
                status: newStatus,
                reviewed_at: new Date().toISOString()
            };

            if (newStatus === "rejected") {
                updatePayload.rejection_reason = rejectionReason || "Does not meet publishing guidelines.";

                // Automatically delete rejected PDF from Supabase Storage to reclaim space!
                const fileToDelete = filePath;
                if (fileToDelete && fileToDelete.trim().length > 0) {
                    try {
                        console.log(`[SupabaseBridge] Rejection: deleting file ${fileToDelete} from storage to save space...`);
                        await client.storage.from(STORAGE_BUCKET).remove([fileToDelete.trim()]);
                        updatePayload.file_path = "";
                        updatePayload.public_url = "";
                    } catch (storageErr) {
                        console.warn("[SupabaseBridge] Storage delete warning on rejection:", storageErr);
                    }
                }
            } else if (newStatus === "accepted") {
                updatePayload.rejection_reason = null;
            }

            console.log(`[SupabaseBridge] Updating submission ${id} to ${newStatus}...`);

            const { data, error } = await client
                .from("book_submissions")
                .update(updatePayload)
                .eq("id", id)
                .select();

            if (error) {
                console.error("[SupabaseBridge] Error updating submission:", error);
                let msg = error.message || error.details || "Update failed.";
                if (msg.includes("infinite recursion") || msg.includes("42P17")) {
                    msg = "Database policy error (infinite recursion in app_admins). Please run the updated supabase-setup.sql in your Supabase SQL Editor.";
                } else if (msg.toLowerCase().includes("row-level security") || msg.toLowerCase().includes("permission denied")) {
                    msg = "Permission denied. Ensure you are signed in as the platform owner and have run supabase-setup.sql.";
                }
                return JSON.stringify({ success: false, error: msg });
            }

            if (!data || data.length === 0) {
                console.warn("[SupabaseBridge] Update returned 0 rows. RLS policy likely prevented the update.");
                return JSON.stringify({
                    success: false,
                    error: "Update permission denied: 0 rows modified. Please ensure you ran the latest supabase-setup.sql in Supabase SQL editor and are signed in as the platform owner."
                });
            }

            console.log(`[SupabaseBridge] Submission ${id} updated successfully:`, data[0]);
            return JSON.stringify({
                success: true,
                submission: data[0]
            });
        } catch (err) {
            console.error("[SupabaseBridge] Exception in supabaseUpdateSubmissionStatus:", err);
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Public Accepted Books (to dynamically merge into BookService in-memory catalog)
    window.supabaseGetAcceptedBooks = async function () {
        const client = getClient();
        if (!client) return JSON.stringify([]);

        try {
            const { data, error } = await client
                .from("book_submissions")
                .select("id, title, author, description, category, year, language, pages, file_size, public_url, created_at")
                .eq("status", "accepted")
                .order("id", { ascending: false });

            if (error) {
                console.warn("[SupabaseBridge] Could not fetch accepted books:", error);
                return JSON.stringify([]);
            }
            return JSON.stringify(data || []);
        } catch (err) {
            console.warn("[SupabaseBridge] Failed to load accepted books:", err);
            return JSON.stringify([]);
        }
    };
})();
