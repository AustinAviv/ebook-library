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
        return true;
    };

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
                    msg = "Signups are disabled in your Supabase project (under Authentication > Providers > Email). Anyone can still submit books as a guest without an account! If you are the platform owner, please use Sign In.";
                }
                return JSON.stringify({ success: false, error: msg });
            }
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email } : null,
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
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email } : null
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    window.supabaseAuthSignOut = async function () {
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
        if (!client) return null;
        try {
            const { data, error } = await client.auth.getUser();
            if (error || !data || !data.user) return null;
            return JSON.stringify({
                id: data.user.id,
                email: data.user.email
            });
        } catch {
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

    window.supabaseUpdateSubmissionStatus = async function (id, newStatus, rejectionReason) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });

        try {
            const updatePayload = {
                status: newStatus,
                reviewed_at: new Date().toISOString()
            };

            if (newStatus === "rejected") {
                updatePayload.rejection_reason = rejectionReason || "Does not meet publishing guidelines.";
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
