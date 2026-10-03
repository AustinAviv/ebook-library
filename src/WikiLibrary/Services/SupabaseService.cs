using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.JSInterop;
using WikiLibrary.Models;

namespace WikiLibrary.Services;

public class SupabaseService
{
    private readonly IJSRuntime _js;
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public AppConfig? Config { get; private set; }
    public SupabaseUser? CurrentUser { get; private set; }
    public bool IsOwner => CurrentUser != null && CurrentUser.IsOwner;

    public bool IsAuthenticated => CurrentUser != null;
    public bool IsInitialized { get; private set; }

    public event Action? AuthStateChanged;

    public SupabaseService(IJSRuntime js, HttpClient http)
    {
        _js = js;
        _http = http;
    }

    public async Task EnsureInitializedAsync()
    {
        if (IsInitialized) return;
        try
        {
            // Fast-path: immediately restore cached user session from localStorage without waiting for network
            try
            {
                var fastCachedUser = await _js.InvokeAsync<string?>("localStorage.getItem", "aviv_user_session");
                if (!string.IsNullOrWhiteSpace(fastCachedUser))
                {
                    CurrentUser = JsonSerializer.Deserialize<SupabaseUser>(fastCachedUser, JsonOptions);
                    AuthStateChanged?.Invoke();
                }
            }
            catch { }

            // 1. Load dynamic config from data/config.json or /api/config
            AppConfig? cfg = null;
            try
            {
                cfg = await _http.GetFromJsonAsync<AppConfig>("data/config.json");
            }
            catch { }

            if (cfg == null || string.IsNullOrWhiteSpace(cfg.SupabaseUrl))
            {
                try
                {
                    cfg = await _http.GetFromJsonAsync<AppConfig>("api/config");
                }
                catch { }
            }

            if (cfg != null)
            {
                Config = cfg;
                if (!string.IsNullOrWhiteSpace(cfg.SupabaseUrl) && !string.IsNullOrWhiteSpace(cfg.SupabaseAnonKey))
                {
                    await _js.InvokeAsync<bool>("supabaseInit", cfg.SupabaseUrl, cfg.SupabaseAnonKey);
                }
            }

            // 2. Fetch and verify current user session with Supabase
            var userJson = await _js.InvokeAsync<string?>("supabaseAuthGetUser");
            if (!string.IsNullOrWhiteSpace(userJson))
            {
                var verified = JsonSerializer.Deserialize<SupabaseUser>(userJson, JsonOptions);
                if (verified != null)
                {
                    CurrentUser = verified;
                    AuthStateChanged?.Invoke();
                }
            }
            else
            {
                // If verified session is null (e.g. token expired and cannot refresh), clear local session
                if (CurrentUser != null)
                {
                    CurrentUser = null;
                    AuthStateChanged?.Invoke();
                }
            }
            IsInitialized = true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] Init error: {ex.Message}");
            IsInitialized = true;
        }
    }

    public async Task<SupabaseAuthResult> SignInAsync(string email, string password)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseAuthSignIn", email, password);
            var result = JsonSerializer.Deserialize<SupabaseAuthResult>(raw, JsonOptions) ?? new SupabaseAuthResult { Success = false, Error = "Failed to parse auth response" };
            if (result.Success && result.User != null)
            {
                CurrentUser = result.User;
                AuthStateChanged?.Invoke();
            }
            return result;
        }
        catch (Exception ex)
        {
            return new SupabaseAuthResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<SupabaseAuthResult> SignUpAsync(string email, string password)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseAuthSignUp", email, password);
            var result = JsonSerializer.Deserialize<SupabaseAuthResult>(raw, JsonOptions) ?? new SupabaseAuthResult { Success = false, Error = "Failed to parse sign up response" };
            if (result.Success && result.User != null)
            {
                CurrentUser = result.User;
                AuthStateChanged?.Invoke();
            }
            return result;
        }
        catch (Exception ex)
        {
            return new SupabaseAuthResult { Success = false, Error = ex.Message };
        }
    }

    public async Task ReloadUserSessionAsync()
    {
        try
        {
            var userJson = await _js.InvokeAsync<string?>("supabaseAuthGetUser");
            if (!string.IsNullOrWhiteSpace(userJson))
            {
                CurrentUser = JsonSerializer.Deserialize<SupabaseUser>(userJson, JsonOptions);
                AuthStateChanged?.Invoke();
            }
        }
        catch { }
    }

    public async Task SignOutAsync()
    {
        try
        {
            await _js.InvokeVoidAsync("supabaseAuthSignOut");
        }
        catch { }
        CurrentUser = null;
        AuthStateChanged?.Invoke();
    }

    public async Task<FileUploadResult> UploadBookFileAsync(string inputElementId, string sanitizedFileName)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseUploadBookFile", inputElementId, sanitizedFileName);
            var result = JsonSerializer.Deserialize<FileUploadResult>(raw, JsonOptions);
            return result ?? new FileUploadResult { Success = false, Error = "Upload response parsing failed" };
        }
        catch (Exception ex)
        {
            return new FileUploadResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<List<UploadFileInfo>> GetSelectedFilesInfoAsync(string inputElementId)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseGetSelectedFilesInfo", inputElementId);
            return JsonSerializer.Deserialize<List<UploadFileInfo>>(raw, JsonOptions) ?? new List<UploadFileInfo>();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] GetSelectedFilesInfo error: {ex.Message}");
            return new List<UploadFileInfo>();
        }
    }

    public async Task<FileUploadResult> UploadBookFileByIndexAsync(string inputElementId, int fileIndex, string sanitizedFileName)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseUploadBookFileByIndex", inputElementId, fileIndex, sanitizedFileName);
            var result = JsonSerializer.Deserialize<FileUploadResult>(raw, JsonOptions);
            return result ?? new FileUploadResult { Success = false, Error = "Upload response parsing failed" };
        }
        catch (Exception ex)
        {
            return new FileUploadResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<SubmissionOperationResult> CreateSubmissionAsync(BookSubmission submission)
    {
        try
        {
            if (CurrentUser != null)
            {
                submission.SubmittedBy = CurrentUser.Id;
                if (string.IsNullOrWhiteSpace(submission.SubmitterEmail))
                {
                    submission.SubmitterEmail = CurrentUser.Email;
                }
            }

            var payload = new
            {
                title = submission.Title,
                author = submission.Author,
                description = submission.Description,
                category = submission.Category,
                year = submission.Year,
                language = submission.Language,
                pages = submission.Pages,
                file_size = submission.FileSize,
                file_path = submission.FilePath,
                public_url = submission.PublicUrl,
                status = "pending",
                submitted_by = submission.SubmittedBy,
                submitter_name = submission.SubmitterName,
                submitter_email = submission.SubmitterEmail
            };

            var payloadJson = JsonSerializer.Serialize(payload);
            var raw = await _js.InvokeAsync<string>("supabaseCreateSubmission", payloadJson);
            var result = JsonSerializer.Deserialize<SubmissionOperationResult>(raw, JsonOptions);
            return result ?? new SubmissionOperationResult { Success = false, Error = "Failed to parse submission response" };
        }
        catch (Exception ex)
        {
            return new SubmissionOperationResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<List<BookSubmission>> GetSubmissionsAsync(string statusFilter = "all")
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseGetSubmissions", statusFilter);
            return JsonSerializer.Deserialize<List<BookSubmission>>(raw, JsonOptions) ?? new List<BookSubmission>();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] GetSubmissions error: {ex.Message}");
            return new List<BookSubmission>();
        }
    }

    public async Task<List<BookSubmission>> GetUserSubmissionsAsync(string email)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseGetUserSubmissions", email);
            return JsonSerializer.Deserialize<List<BookSubmission>>(raw, JsonOptions) ?? new List<BookSubmission>();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] GetUserSubmissions error: {ex.Message}");
            return new List<BookSubmission>();
        }
    }

    public async Task<SubmissionOperationResult> UpdateSubmissionStatusAsync(long id, string status, string? rejectionReason = null, string? filePath = null)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseUpdateSubmissionStatus", id, status, rejectionReason, filePath);
            var result = JsonSerializer.Deserialize<SubmissionOperationResult>(raw, JsonOptions);
            return result ?? new SubmissionOperationResult { Success = false, Error = "Failed to parse update response" };
        }
        catch (Exception ex)
        {
            return new SubmissionOperationResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<bool> DeleteBookFileAsync(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath)) return true;
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseDeleteBookFile", filePath);
            var result = JsonSerializer.Deserialize<SubmissionOperationResult>(raw, JsonOptions);
            return result?.Success ?? false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] DeleteBookFile error: {ex.Message}");
            return false;
        }
    }

    public async Task<List<BookSubmission>> GetAcceptedBooksAsync()
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseGetAcceptedBooks");
            return JsonSerializer.Deserialize<List<BookSubmission>>(raw, JsonOptions) ?? new List<BookSubmission>();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] GetAcceptedBooks error: {ex.Message}");
            return new List<BookSubmission>();
        }
    }

    public async Task<List<int>> GetRemovedCatalogBooksAsync()
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseGetRemovedCatalogBooks");
            return JsonSerializer.Deserialize<List<int>>(raw, JsonOptions) ?? new List<int>();
        }
        catch
        {
            return new List<int>();
        }
    }

    public async Task<bool> RemoveCoreCatalogBookAsync(int bookId)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseRemoveCoreCatalogBook", bookId);
            var result = JsonSerializer.Deserialize<SubmissionOperationResult>(raw, JsonOptions);
            return result?.Success ?? false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] RemoveCoreCatalogBook error: {ex.Message}");
            return false;
        }
    }

    public async Task<bool> RemoveCommunityBookAsync(long submissionId, string? filePath)
    {
        try
        {
            var raw = await _js.InvokeAsync<string>("supabaseDeleteCommunityBook", submissionId, filePath);
            var result = JsonSerializer.Deserialize<SubmissionOperationResult>(raw, JsonOptions);
            return result?.Success ?? false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SupabaseService] RemoveCommunityBook error: {ex.Message}");
            return false;
        }
    }
}
