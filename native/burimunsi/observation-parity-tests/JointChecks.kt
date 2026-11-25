import java.io.File
import rw.ikanisa.burimunsi.core.ObservedReceiptEvidence
import rw.ikanisa.burimunsi.core.ReceiptProfile
fun main(args:Array<String>) {
    val profile=ReceiptProfile("synthetic",setOf("Example Money"),120,setOf("Received"),setOf("RWF"),setOf("Reference:"))
    File(args[0]).forEachLine { line ->
        val (name, _, sender, body)=line.split('\t',limit=4)
        println(name+"\t"+ObservedReceiptEvidence.isNewCandidate(sender,body,profile))
    }
}
