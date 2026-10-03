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

        try {
            supabaseClient.auth.onAuthStateChange(async (event, session) => {
                if (session && session.user) {
                    try {
                        const meta = await getUserRole(session.user.id);
                        localStorage.setItem("aviv_user_session", JSON.stringify({
                            id: session.user.id,
                            email: session.user.email,
                            role: meta.role,
                            uid: meta.uid
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

    async function getUserRole(userId) {
        if (!userId) return { role: "user", uid: "" };
        try {
            const client = getClient();
            if (!client) return { role: "user", uid: "" };
            const { data, error } = await client
                .from("user_roles")
                .select("role, uid")
                .eq("user_id", userId)
                .maybeSingle();

            if (error || !data) return { role: "user", uid: "" };
            return {
                role: data.role || "user",
                uid: data.uid || ""
            };
        } catch {
            return { role: "user", uid: "" };
        }
    }

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
                    msg = "Signups are disabled in your Supabase project configuration. Please sign in with an existing account.";
                }
                return JSON.stringify({ success: false, error: msg });
            }
            let role = "user";
            let uid = "";
            if (data && data.user) {
                const meta = await getUserRole(data.user.id);
                role = meta.role;
                uid = meta.uid;
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify({
                        id: data.user.id,
                        email: data.user.email,
                        role: role,
                        uid: uid
                    }));
                } catch { }
            }
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email, role: role, uid: uid } : null,
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
            let uid = "";
            if (data && data.user) {
                const meta = await getUserRole(data.user.id);
                role = meta.role;
                uid = meta.uid;
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify({
                        id: data.user.id,
                        email: data.user.email,
                        role: role,
                        uid: uid
                    }));
                } catch { }
            }
            return JSON.stringify({
                success: true,
                user: data.user ? { id: data.user.id, email: data.user.email, role: role, uid: uid } : null
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
            try {
                const cached = localStorage.getItem("aviv_user_session");
                if (cached) return cached;
            } catch { }
            return null;
        }

        try {
            const { data: sessionData } = await client.auth.getSession();
            if (sessionData && sessionData.session && sessionData.session.user) {
                const user = sessionData.session.user;
                const meta = await getUserRole(user.id);
                const u = {
                    id: user.id,
                    email: user.email,
                    role: meta.role,
                    uid: meta.uid
                };
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify(u));
                } catch { }
                return JSON.stringify(u);
            }

            const { data, error } = await client.auth.getUser();
            if (!error && data && data.user) {
                const user = data.user;
                const meta = await getUserRole(user.id);
                const u = {
                    id: user.id,
                    email: user.email,
                    role: meta.role,
                    uid: meta.uid
                };
                try {
                    localStorage.setItem("aviv_user_session", JSON.stringify(u));
                } catch { }
                return JSON.stringify(u);
            }

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

    // Supabase Storage Upload
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

        const maxBytes = 50 * 1024 * 1024;
        if (file.size > maxBytes) {
            return JSON.stringify({ success: false, error: "File exceeds 50 MB maximum limit." });
        }

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

    window.supabaseDeleteBookFile = async function (filePath) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        if (!filePath || filePath.trim().length === 0) return JSON.stringify({ success: true });

        try {
            const { data, error } = await client.storage
                .from(STORAGE_BUCKET)
                .remove([filePath.trim()]);

            if (error) {
                console.warn("[SupabaseBridge] Storage removal error:", error);
                return JSON.stringify({ success: false, error: error.message });
            }

            return JSON.stringify({ success: true });
        } catch (err) {
            console.warn("[SupabaseBridge] Exception removing storage file:", err);
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Submissions Management
    window.supabaseCreateSubmission = async function (payloadJson) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });

        try {
            const payload = JSON.parse(payloadJson);

            const insertResult = await client
                .from("book_submissions")
                .insert([payload])
                .select();

            if (insertResult.error) {
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

                const fileToDelete = filePath;
                if (fileToDelete && fileToDelete.trim().length > 0) {
                    try {
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

            const { data, error } = await client
                .from("book_submissions")
                .update(updatePayload)
                .eq("id", id)
                .select();

            if (error) {
                console.error("[SupabaseBridge] Error updating submission:", error);
                let msg = error.message || error.details || "Update failed.";
                if (msg.includes("infinite recursion") || msg.includes("42P17")) {
                    msg = "Database policy error. Please run the updated supabase-setup.sql in your Supabase SQL Editor.";
                } else if (msg.toLowerCase().includes("row-level security") || msg.toLowerCase().includes("permission denied")) {
                    msg = "Permission denied. Ensure you are signed in as the platform owner.";
                }
                return JSON.stringify({ success: false, error: msg });
            }

            if (!data || data.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: "Update permission denied: 0 rows modified. Please ensure you are signed in with the owner role."
                });
            }

            return JSON.stringify({
                success: true,
                submission: data[0]
            });
        } catch (err) {
            console.error("[SupabaseBridge] Exception in supabaseUpdateSubmissionStatus:", err);
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Public Accepted Books Query
    window.supabaseGetAcceptedBooks = async function () {
        const client = getClient();
        if (!client) return JSON.stringify([]);

        try {
            const { data, error } = await client
                .from("book_submissions")
                .select("id, title, author, description, category, year, language, pages, file_size, file_path, public_url, created_at")
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

    // Catalog Management: Removed Core Books
    window.supabaseGetRemovedCatalogBooks = async function () {
        const client = getClient();
        if (!client) return JSON.stringify([]);
        try {
            const { data, error } = await client
                .from("removed_catalog_books")
                .select("book_id");

            if (error || !data) return JSON.stringify([]);
            return JSON.stringify(data.map(r => r.book_id));
        } catch {
            return JSON.stringify([]);
        }
    };

    window.supabaseRemoveCoreCatalogBook = async function (bookId) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        try {
            const { error } = await client
                .from("removed_catalog_books")
                .upsert([{ book_id: bookId }]);

            if (error) return JSON.stringify({ success: false, error: error.message });
            return JSON.stringify({ success: true });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };

    // Catalog Management: Permanent Community Book Deletion (Storage File + Database Row)
    window.supabaseDeleteCommunityBook = async function (submissionId, filePath) {
        const client = getClient();
        if (!client) return JSON.stringify({ success: false, error: "Supabase not initialized." });
        try {
            let pathToDelete = filePath;
            if (!pathToDelete && submissionId) {
                const { data } = await client
                    .from("book_submissions")
                    .select("file_path")
                    .eq("id", submissionId)
                    .maybeSingle();
                if (data && data.file_path) {
                    pathToDelete = data.file_path;
                }
            }

            if (pathToDelete && pathToDelete.trim().length > 0) {
                try {
                    await client.storage.from(STORAGE_BUCKET).remove([pathToDelete.trim()]);
                } catch (storageErr) {
                    console.warn("[SupabaseBridge] Storage removal warning:", storageErr);
                }
            }

            const { error } = await client
                .from("book_submissions")
                .delete()
                .eq("id", submissionId);

            if (error) {
                return JSON.stringify({ success: false, error: error.message });
            }

            return JSON.stringify({ success: true });
        } catch (err) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    };
})();
