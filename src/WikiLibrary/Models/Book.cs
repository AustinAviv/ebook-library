namespace WikiLibrary.Models;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string? Author { get; set; }
    public string? Description { get; set; }
    public string? Category { get; set; }
    public int Year { get; set; }
    public string? Language { get; set; }
    public int Pages { get; set; }
    public long FileSize { get; set; }
    public string BlobPathname { get; set; } = "";
    public string? Url { get; set; }
    public string? DownloadUrl { get; set; }
    public bool IsCommunityPublished { get; set; }
    public string? StorageFilePath { get; set; }
    public long? SubmissionId { get; set; }

    public bool HasAuthor => !string.IsNullOrWhiteSpace(Author) && !Author.Equals("Unknown author", StringComparison.OrdinalIgnoreCase);
    public bool HasCategory => !string.IsNullOrWhiteSpace(Category) && !Category.Equals("Uncategorized", StringComparison.OrdinalIgnoreCase);
    public bool HasDescription => !string.IsNullOrWhiteSpace(Description) && !Description.Equals("No description yet.", StringComparison.OrdinalIgnoreCase);

    public string EffectiveDownloadUrl
    {
        get
        {
            if (IsCommunityPublished)
            {
                var cleanTitle = System.Text.RegularExpressions.Regex.Replace(Title ?? "book", @"[^\w\.\-\s]", "").Trim();
                if (string.IsNullOrWhiteSpace(cleanTitle)) cleanTitle = "book";
                var safeName = cleanTitle.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? cleanTitle : cleanTitle + ".pdf";

                if (!string.IsNullOrWhiteSpace(DownloadUrl))
                {
                    return $"/api/download?id={Id}&title={Uri.EscapeDataString(safeName)}&url={Uri.EscapeDataString(DownloadUrl)}";
                }
                return $"/api/download?id={Id}&title={Uri.EscapeDataString(safeName)}";
            }

            return $"/api/download?id={Id}";
        }
    }

    public string DirectStorageDownloadUrl
    {
        get
        {
            if (IsCommunityPublished && !string.IsNullOrWhiteSpace(DownloadUrl))
            {
                var cleanTitle = System.Text.RegularExpressions.Regex.Replace(Title ?? "book", @"[^\w\.\-\s]", "").Trim();
                if (string.IsNullOrWhiteSpace(cleanTitle)) cleanTitle = "book";
                var safeName = cleanTitle.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? cleanTitle : cleanTitle + ".pdf";
                var sep = DownloadUrl.Contains('?') ? "&" : "?";
                return $"{DownloadUrl}{sep}download={Uri.EscapeDataString(safeName)}";
            }
            return !string.IsNullOrWhiteSpace(DownloadUrl) ? DownloadUrl : $"/api/download?id={Id}";
        }
    }

    public string EffectiveViewUrl
    {
        get
        {
            if (IsCommunityPublished && !string.IsNullOrWhiteSpace(Url))
            {
                return Url.Replace("?download=", "?dl=").Replace("&download=", "&dl=");
            }
            return !string.IsNullOrWhiteSpace(Url) ? Url : (!string.IsNullOrWhiteSpace(DownloadUrl) ? DownloadUrl : $"/api/download?id={Id}&view=1");
        }
    }

    public string FileSizeText
    {
        get
        {
            if (FileSize <= 0) return "-";
            double mb = FileSize / (1024.0 * 1024.0);
            if (mb >= 1.0)
                return $"{mb:F1} MB";
            double kb = FileSize / 1024.0;
            return $"{kb:F0} KB";
        }
    }

    public string YearText => Year > 0 ? Year.ToString() : "-";
    public string PagesText => Pages > 0 ? Pages.ToString("N0") : "-";
}
