# eActivities API 

## **Contents** 

|Introduction ....................................................................................................................................................... 1|
|---|
|Basic Information........................................................................................................................................... 1|
|Authentication ............................................................................................................................................... 1|
|Authentication errors ................................................................................................................................ 1|
|Excessive requests ..................................................................................................................................... 1|
|Operations ......................................................................................................................................................... 2|
|Clubs/Societies/Projects list .......................................................................................................................... 2|
|Club/Society/Project details .......................................................................................................................... 2|
|Committee Members .................................................................................................................................... 2|
|Members ....................................................................................................................................................... 2|
|Online Sales ................................................................................................................................................... 3|
|List online sales by year ............................................................................................................................. 3|
|Products ......................................................................................................................................................... 3|
|List products .............................................................................................................................................. 3|
|List products by year.................................................................................................................................. 4|
|Get a product ............................................................................................................................................. 5|
|List sales of a product ................................................................................................................................ 6|
|Profile Entry ................................................................................................................................................... 6|
|Get current profile entry ........................................................................................................................... 6|
|Signups........................................................................................................................................................... 7|
|List signups ................................................................................................................................................ 7|
|Get a signup ............................................................................................................................................... 7|
|Transaction Lines ........................................................................................................................................... 8|
|List transaction lines by year ..................................................................................................................... 8|
|What’s On Events .......................................................................................................................................... 8|
|List What’s On events ................................................................................................................................ 8|
|Get a What’s On event .............................................................................................................................. 9|



## **Introduction** 

The eActivities API is intended for use by Clubs, Societies & Projects of Imperial College Union and is intended for low volume usage to assist with CSP operations. Excessive usage of the API will result is the removal of usage rights. 

It is the responsibility of the Club, Society & Project officers to ensure the API key is kept secret and is used only for appropriate applications (please seek advice from the Student Activities team if you are unsure as to whether your application constitutes appropriate usage). 

### **Basic Information** 

The endpoint for the API is **<u>https://eactivities.union.ic.ac.uk/API.</u>** 

By default the eActivities API will respond in JSON, however including an Accept header with value application/xml will cause the API to respond with XML. 

### **Authentication** 

An API key must be included in each request either as the password of a HTTP Basic Auth header or as a “XAPI-Key” header. API keys are obtained through the main eActivities site. 

#### **Authentication errors** 

If no API key is specified or the API key is invalid you will receive a response like the below 

```
HTTP 401 Unauthorised
{
```

```
“message”: “Please specify an API key”
}
```

Repeated failed attempts will lead to requesting IP being banned for an hour. 

```
HTTP 403 Forbidden
{
```

```
“message”: “IP address xxx.xxx.xxx.xxx has been banned until 20\/06\/2015 19:00:00”
}
```

#### **Excessive requests** 

Excessive requests to the API will result in a short 5 minute ban. 

```
HTTP 403 Forbidden
{
```

```
“message”: “IP address xxx.xxx.xxx.xxx has been banned until 20\/06\/2015 18:05:00”
}
```

1 

## **Operations** 

**Clubs/Societies/Projects list** GET /CSP 

Gets the list of Clubs, Societies or Projects that you can view information for. 

```
HTTP 200 OK
[
{
"Code":"170",
"Name":"RCC Ferret Fanciers (TEST CLUB)",
"WebName":"Ferrets",
"Acronym":"RFF",
}
]
```

### **Club/Society/Project details** 

GET /CSP/{centre} 

{centre} Centre code for the CSP. 

Gets the basic details, such as Name, Website Name and Code, for the specified CSP. 

```
HTTP 200 OK
{
"Code":"170",
"Name":"RCC Ferret Fanciers (TEST CLUB)",
"WebName":"Ferrets",
"Acronym":"RFF",
}
```

### **Committee Members** 

GET /CSP/{centre}/reports/committee?year={year} 

{centre} Centre code for the CSP. 

{year} Year should be in the format xx-xx (e.g. 13-14). If not set the response is for the current year. 

Obtains the list of committee members for the specified CSP. 

```
HTTP 200 OK
[
{
"FirstName":"Joe",
"Surname":"Bloggs",
"CID":"00000000",
"Email":"joe.bloggs50@imperial.ac.uk",
"Login":"jbloggs50",
"PostName":”Chief Ferret Fancier”,
"PhoneNo":"02075948060",
“StartDate”:”2014-08-01 00:00:00”,
“EndDate”:”2015-07-31 23:59:59”
}
]
```

### **Members** 

GET /CSP/{centre}/reports/members?year={year} 

{centre} Centre code for the CSP. 

2 

{year} Year should be in the format xx-xx (e.g. 13-14). If not set the response is for the current year. Obtains the list of members for the specified CSP. 

```
HTTP 200 OK
[
{
"FirstName":"Joe",
"Surname":"Bloggs",
"CID":"00000000",
"Email":"joe.bloggs50@imperial.ac.uk",
"Login":"jbloggs50",
"OrderNo":1000,
"MemberType":"Full"
}
]
```

**Online Sales** 

**List online sales by year** GET /CSP/{centre}/reports/onlinesales?year={year} 

{centre} Centre code for the CSP. 

{year} Year should be in the format xx-xx (e.g. 13-14). If not set the response is for the current year. 

Obtains the list of online sales for the specified CSP. 

```
HTTP 200 OK
[
{
"OrderNumber":"1000",
"SaleDateTime":"2015-06-20 19:00:00",
"ProductID":1234,
"ProductLineID":4567,
"Price":30,
"Quantity":1,
"QuantityCollected":0,
"Customer":
{
"FirstName":"Joe",
"Surname":"Bloggs",
"CID":"00000000",
"Email":" joe.bloggs50@imperial.ac.uk ",
"Login":"jbloggs50"
},
"VAT":
{
"Code":"S1",
"Name":"S1 – Sales Standard Rated",
"Rate":20,
}
}
]
```

**Products** 

**List products** GET /csp/{centre}/products 

{centre} Centre code for the CSP. 

Returns the list of all online products and their associated product lines. 

3 

```
HTTP 200 OK
[
{
"ID":1234,
"Name":"Ferret Fanciers Annual Dinner 2015",
"Description":"Ticket for our Annual Dinner 2015 ",
"Type":"World - Products available to everyone including non-Imperial students and
staff",
"SellingDateStart":"2015-06-01 00:00:00",
"SellingDateEnd":"2015-06-30 00:00:00",
"URL":"https://www.imperialcollegeunion.org/shop/club-society-project-
products/ferrets-products/1234/ferret-annual-dinner-2015",
"Active":true,
“ProductLines”:
[
{
"ID": 4567,
     "Name": "Ferret Annual Dinner Ticket",
     "Quantity": null,
     "Unlimited": true,
     "Price": 30,
     "Collectable": false,
     "DefaultOption": true,
  "Account":
  {
"Code": "580",
"Name": "Ticket Income (580)",
"Type": "Income”,
  },
  "Activity":
  {
"Code": "00",
"Name": "General (0)",
  },
  "VAT":
  {
"Code":"S1",
"Name":"S1 – Sales Standard Rated",
"Rate":20,
  }
}
]
}
]
```

**List products by year** GET /csp/{centre}/reports/products?year={year} 

{centre} Centre code for the CSP. 

{year} Year should be in the format xx-xx (e.g. 13-14). If not set the response is for the current year. 

Returns the list of all online products and their associated product lines created in the specified year. 

```
HTTP 200 OK
[
{
"ID":1234,
"Name":"Ferret Fanciers Annual Dinner 2015",
"Description":"Ticket for our Annual Dinner 2015 ",
"Type":"World - Products available to everyone including non-Imperial students and
staff",
"SellingDateStart":"2015-06-01 00:00:00",
"SellingDateEnd":"2015-06-30 00:00:00",
"URL":"https://www.imperialcollegeunion.org/shop/club-society-project-
products/ferrets-products/1234/ferret-annual-dinner-2015",
"Active":true,
```

4 

`“ProductLines”: [ { "ID": 4567, "Name": "Ferret Annual Dinner Ticket", "Quantity": null, "Unlimited": true, "Price": 30, "Collectable": false, "DefaultOption": true, "Account": { "Code": "580", "Name": "Ticket Income (580)", "Type": "Income”, }, "Activity": { "Code": "00", "Name": "General (0)", }, "VAT": { "Code":"S1", "Name":"S1 – Sales Standard Rated", "Rate":20, } } ] } ]` **Get a product** GET /csp/{centre}/products/{id} 

{centre} Centre code for the CSP. {id} ID of the product. Return details of the product with the specified id. 

```
HTTP 200 OK
{
"ID":1234,
"Name":"Ferret Fanciers Annual Dinner 2015",
"Description":"Tickets for our Annual Dinner 2015",
"Type":"World - Products available to everyone including non-Imperial students and
staff",
"SellingDateStart":"2015-06-01 00:00:00",
"SellingDateEnd":"2015-06-30 00:00:00",
"URL":"https://www.imperialcollegeunion.org/shop/club-society-project-
products/ferrets-products/1234/ferret-annual-dinner-2015",
"Active":true,
“ProductLines”:
[
{
"ID": 4567,
     "Name": "Ferret Annual Dinner Ticket",
     "Quantity": null,
     "Unlimited": true,
     "Price": 30,
     "Collectable": false,
     "DefaultOption": true,
     "Account":
{
"Code": "580",
"Name": "Ticket Income (580)",
"Type": "Income”,
```

5 

```
},
"Activity":
{
"Code": "00",
"Name": "General (0)",
},
"VAT":
{
"Code":"S1",
"Name":"S1 – Sales Standard Rated",
"Rate":20,
}
]
}
]
```

**List sales of a product** GET /csp/{centre}/products/{id}/sales 

{centre} Centre code for the CSP. 

{id} ID of the product. 

Returns the list of sales of the specified online product. 

```
HTTP 200 OK
[
{
"OrderNumber":"1000",
"SaleDateTime":"2015-06-20 19:00:00",
"ProductID":1234,
"ProductLineID":4567,
"Price":30,
"Quantity":1,
"QuantityCollected":0,
"Customer":
{
"FirstName":"Joe",
"Surname":"Bloggs",
"CID":"00000000",
"Email":" joe.bloggs50@imperial.ac.uk ",
"Login":"jbloggs50"
}
"VAT":
{
"Code":"S1",
"Name":"S1 – Sales Standard Rated",
"Rate":20,
}
}
]
```

**Profile Entry** 

**Get current profile entry** GET /csp/{centre}/profileentry 

{centre} Centre code for the CSP. 

Returns the profile entry for the specified CSP. 

```
HTTP 200 OK
{
```

> `"LargeProfile":"Ferrets - the great British creature! Imperial's all-new Ferret Fanciers society is committed to promoting the world's favourite animal and making sure` 

6 

```
you can enjoy every one of these furry creatures from near and afar. We provide regular
times and places for students to take time out from their busy schedules to take ferret-
stroking breaks together, and also host large scale ferret wrangling events and talks
from big names in the ferret world.",
```

```
"LastChanged":"2015-06-20 19:00:00",
"SmallProfile":"Celebrating the Great British Ferret Ferret Fanciers is committed to
promoting Britain's greatest creature. Why not join us for a relaxing ferret-stroking
break?"
}
```

**Signups** 

**List signups** GET /csp/{centre}/signups 

{centre} Centre code for the CSP. 

Returns the list of all signups for the specified CSP. 

```
HTTP 200 OK
[
{
"ID": 29,
"Title": "Ferret Fanciers Annual Dinner – Vegetarian Option",
"Description": "Please sign up to the list if you have bought a ticket to the
annual dinner and would like the vegetarian option.",
"SignupOpen": "2015-06-01 12:00:00",
"SignupClose": "2015-06-24 17:00:00",
"AttendeesCount": 2,
"MaximumAttendees": 100
}
]
```

**Get a signup** GET /csp/{centre}/signups/{id} 

{centre} Centre code for the CSP. {id} ID of the signup. 

Returns the specified signup. `HTTP 200 OK { "ID": 29, "Title": "Ferret Fanciers Annual Dinner – Vegetarian Option", "Description": "Please sign up to the list if you have bought a ticket to the annual dinner and would like the vegetarian option.", "SignupOpen": "2015-06-01 12:00:00", "SignupClose": "2015-06-24 17:00:00", "AttendeesCount": 2, "MaximumAttendees": 100 "Attendees": [ { "FirstName":"Joe", "Surname":"Bloggs", "CID":"00000000", "Email":" joe.bloggs50@imperial.ac.uk ", "Login":"jbloggs50" }, { "FirstName":"John", "Surname":"Smith",` 

7 

```
"CID":"03141592",
"Email":" john.smith60@imperial.ac.uk ",
"Login":"jsmith60"
}
]
}
```

### **Transaction Lines** 

**List transaction lines by year** 

GET /csp/{centre}/reports/ transactionlines?year={year} 

{centre} Centre code for the CSP. {year} Year should be in the format xx-xx (e.g. 13-14). If not set the response is for the current year. 

Returns the list of transaction lines for the specified CSP and year. 

```
HTTP 200 OK
[
{
"TransID": 234567,
"TransDate": "2015-06-20",
"Document": "CF 12345 (234567)",
"Description": "Pens and card for making signs",
"Amount": -234,
"Funding":
{
"Code": "0",
"Name": "Grant (0)",
},
"Activity":
{
"Code": "00",
"Name": "General (0)",
},
"Account":
{
"Code": "860",
"Name": "Stationery (860)",
"Type": "Expenditure”,
},
"Pending": true,
"Outstanding": false }
}
]
```

### **What’s On Events** 

**List What’s On events** GET /csp/{centre}/whatson 

Returns the list of all What’s On events created by the specified CSP. 

```
HTTP 200 OK
[
  {
    "ID": 1234,
    "Title": "Ferret Fanciers Annual Dinner 2015",
    "Description": "Our annual dinner 2015",
    "EventStart": "2015-07-01 19:00:00",
    "EventEnd": "2015-07-01 23:00:00",
    "Location": "Union Dining Hall (UDH)",
    "PostCode": "SW7 2BB",
    "EventType": "Social & Recreational",
```

8 

```
    "Active": true
```

```
  }
]
```

**Get a What’s On event** GET /csp/{centre}/whatson/{id} 

{centre} Centre code for the CSP. 

{id} ID of the What’s On event 

Return details of the event with the specified id. This will also return an array of signups associated with this event (if any). 

```
HTTP 200 OK
{
   "ID": 1234,
   "Title": "Ferret Fanciers Annual Dinner 2015",
   "Description": "Our annual dinner 2015",
   "EventStart": "2015-07-01 19:00:00",
   "EventEnd": "2015-07-01 23:00:00",
   "Location": "Union Dining Hall (UDH)",
   "PostCode": "SW7 2BB",
   "EventType": "Social & Recreational",
   "Active": true
"Signups":
[
{
"ID": 29,
"Title": "Ferret Fanciers Annual Dinner – Vegetarian Option",
"Description": "Please sign up to the list if you have bought a ticket to the
annual dinner and would like the vegetarian option.",
"SignupOpen": "2015-06-01 12:00:00",
"SignupClose": "2015-06-24 17:00:00",
"AttendeesCount": 2,
"MaximumAttendees": 100
```

```
}
]
}
```

9 

