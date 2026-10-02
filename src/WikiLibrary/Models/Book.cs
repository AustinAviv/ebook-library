namespace WikiLibrary.Models;

/// <summary>One book, exactly as stored in wwwroot/data/books.json.</summary>
public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string Description { get; set; } = "";
    public string Category { get; set; } = "";
    public int Year { get; set; }
    public string Language { get; set; } = "";
    public int Pages { get; set; }
    public long FileSize { get; set; }            // bytes
    public string BlobPathname { get; set; } = ""; // pathname only, never a full URL

    /// <summary>"3.4 MB" style text for the infobox.</summary>
    public string FileSizeText
    {
        get
        {
            if (FileSize <= 0) return "—";
            double mb = FileSize / 1024.0 / 1024.0;
            return mb >= 1 ? $"{mb:0.0} MB" : $"{FileSize / 1024.0:0} KB";
        }
    }

    public string YearText => Year > 0 ? Year.ToString() : "—";
    public string PagesText => Pages > 0 ? Pages.ToString("N0") : "—";
}
