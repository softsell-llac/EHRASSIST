// weaviateservices.mjs
import weaviate from 'weaviate-ts-client';

// Initialize Weaviate client
function initWeaviateClient() {
  return weaviate.client({
    scheme: "http",
    host: process.env.WEAVIATE_HOST || "localhost:8080",
  });
}

// Function to perform the search query with improved relevance
async function searchDocuments(query, dept) {
   const weaviateClient = initWeaviateClient();
  console.log("Searching Weaviate for:", query);
  
  try {
    // Split the query into words
    let searchTerms = [];
    
    // If query contains commas, split by commas
    if (typeof query === 'string' && query.includes(',')) {
      searchTerms = query.split(',')
        .map(term => term.trim())
        .filter(term => term.length > 0);
    } 
    // If no commas, split by spaces to get individual words
    else if (typeof query === 'string') {
      searchTerms = query.split(' ')
        .map(term => term.trim())
        .filter(term => term.length > 0);
    }
    
    // If empty after processing, return empty array
    if (searchTerms.length === 0) {
      return [];
    }
    
    console.log("dept", dept);
    console.log("searchTerms", searchTerms);
    
    // Create a query where ANY of the words should match (Or operator)
    const result = await weaviateClient.graphql
      .get()
      .withClassName("Documents") 
      .withFields(["content", "filename", "title", "upload_date"])
      .withWhere({
        operator: "And",
        operands: [
          {
            // Department must match
            path: ["category"],
            operator: "Like",
            valueText: dept
          },
          {
            // ANY word in the query should match with manual_tags
            operator: "Or",
            operands: searchTerms.map(term => ({
              path: ["manual_tags"],
              operator: "Like",
              valueText: term,
            }))
          }
        ]
      })
      .withLimit(10) 
      .do();
    
    // If no results found for manual_tags, don't perform fallback search
    if (!result.data.Get.Documents || result.data.Get.Documents.length === 0) {
      console.log("No matches found in manual_tags");
      return [];
    }
    
    console.log("Search results:", result.data.Get.Documents);
    return result.data.Get.Documents;
    
  } catch (error) {
    console.error("Error during search:", error);
    return [];
  }
}

export {
  searchDocuments
};