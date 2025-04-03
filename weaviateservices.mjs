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
async function searchDocuments(query,dept) {
   const weaviateClient = initWeaviateClient();
   console.log("Searching Weaviate for:", query);
   
   try {
     // Clean up the query - if it's a comma-separated list, split and process
     let searchTerms = query;
     console.log("dept",dept);
 
 
     if (typeof query === 'string' && query.includes(',')) {
       searchTerms = query.split(',')
         .map(term => term.trim())
         .filter(term => term.length > 0);
     }
     
     // If we have an array of search terms, build a more complex query
     if (Array.isArray(searchTerms)) {
       // Create a combined query for each term
       const result = await weaviateClient.graphql
         .get()
         .withClassName("Documents") // Replace with your class name
         .withFields(["content", "filename", "title", "upload_date"]) // Modify according to your schema
         .withWhere({
           operator: "And",
           operands: [
             {
               operator: "And",
               operands: searchTerms.map(term => ({
                 path: ["content"],
                 operator: "Like",
                 valueText: term,
               }))
             },
             {
               operator: "And",
               operands: searchTerms.map(term => ({
                 path: ["category"],
                 operator: "Like",
                 valueText: dept,
               }))
             }
           ]
         })
         .withLimit(1) // Get top 5 results
         .do();
         
       //console.log("Search results for terms array:", result.data.Get.Documents);
       return result.data.Get.Documents;
     }
     // Single term search
     else {
       const result = await weaviateClient.graphql
         .get()
         .withClassName("Documents") // Your class name
         .withFields(["content", "filename", "title", "upload_date"]) // Fetching all known fields
         .withWhere({
           operator: "And",
           operands: [
             {
               path: ["category"],
               operator: "Like", 
               valueText: dept // Match query anywhere in category
             },
             {
               path: ["content"],
               operator: "Like", 
               valueText: query // Match query anywhere in content
             }
           ]
         })
         .withLimit(1)
         .do();
       
       // If primary search returns no results, fall back to a broader search
       if (!result.data.Get.Documents || result.data.Get.Documents.length === 0) {
         const fallbackResult = await weaviateClient.graphql
           .get()
           .withClassName("Documents")
           .withFields(["content", "filename", "title", "upload_date"])
           .withWhere({
             operator: "And",
             operands: [
               {
                 path: ["category"],
                 operator: "Like", 
                 valueText: dept 
               },
               {
                 path: ["content"],
                 operator: "Like", 
                 valueText: query
               },
               
             ]
           })        
           .withLimit(1)
           .do();
           
         console.log("Fallback search results:", fallbackResult.data.Get.Documents);
         return fallbackResult.data.Get.Documents;
       }
       
       console.log("Primary search results:", result.data.Get.Documents);
       return result.data.Get.Documents;
     }
   } catch (error) {
     console.error("Error during search:", error);
     return [];
   }
 }

export {
  searchDocuments
};